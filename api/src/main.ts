import http from 'node:http';
import { createRequire } from 'node:module';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';

import { config } from './config.js';
import { num, guardar, pegar, chave } from './utils.js';
import { Logger } from './infra/logger.js';
import { conectarMysql, consultar } from './infra/mysql.js';
import { conectarRedis } from './infra/redis.js';

import { DriverRepository } from './modules/driver/driver.repository.js';
import { DriverService } from './modules/driver/driver.service.js';
import { EventsEmitter } from './modules/events/events.emitter.js';
import { EventsRoomService } from './modules/events/events.rooms.js';
import { EventsGateway } from './modules/events/events.gateway.js';
import { SimulacaoService } from './modules/simulacao/simulacao.service.js';
import { TripRepository } from './modules/trip/trip.repository.js';
import { TripService } from './modules/trip/trip.service.js';
import { PricingService } from './modules/pricing/pricing.service.js';
import { GeocodingService } from './modules/geocoding/geocoding.service.js';
import { TelemetryService } from './modules/telemetry/telemetry.service.js';
import { TelemetryExporter } from './modules/telemetry/telemetry.exporter.js';
import { PainelService } from './modules/painel/painel.service.js';
import {
  FleetLinkTelemetrySink,
  LocalTelemetrySink,
} from './modules/telemetry/telemetry.sink.js';

const require_ = createRequire(import.meta.url);
const { TelemetryUploader } = require_('../vendor/fleet-telemetry-sdk/src/telemetry-uploader.js');

const logger = new Logger('Main');

/*
 * Express 4 nao encaminha rejeicao de promise de um handler async pro
 * middleware de erro. Sem isso, uma excecao (ex: NaN chegando numa query
 * SQL) vira unhandled rejection e derruba o processo inteiro, nao so a
 * request que causou o erro.
 */
function assincrono(
  fn: (req: express.Request, res: express.Response) => Promise<void>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res).catch(next);
  };
}

async function bootstrap() {
  await conectarMysql();
  await conectarRedis();

  const app = express();
  app.use(cors());
  app.use(express.json());

  const servidor = http.createServer(app);

  const io = new Server(servidor, {
    cors: { origin: '*', credentials: true },
    transports: ['websocket', 'polling'],
  });

  const driverRepository = new DriverRepository();
  const driverService = new DriverService(driverRepository);
  const emitter = new EventsEmitter(driverService);
  const salas = new EventsRoomService();
  const simulacaoService = new SimulacaoService();
  const tripService = new TripService(new TripRepository());
  const pricingService = new PricingService();
  const geocodingService = new GeocodingService();
  const telemetryService = new TelemetryService();

  // Envio de telemetria de posicao para o coletor de observabilidade.
  const uploaderVendor = new TelemetryUploader({
    endpoint: process.env.FLEETLINK_ENDPOINT,
    logger,
  });
  const uploaderAtivo = await uploaderVendor.start();

  const telemetryExporter = new TelemetryExporter();

  

  if (!uploaderAtivo) {
    telemetryExporter.iniciar();
    logger.info('[Telemetry] usando exporter próprio como fallback');
  }

  const telemetrySink = uploaderAtivo
  ? new FleetLinkTelemetrySink(uploaderVendor)
  : new LocalTelemetrySink(telemetryExporter);

  const painelService = new PainelService(emitter);

  new EventsGateway(
    io,
    emitter,
    salas,
    driverService,
    telemetryService,
    telemetrySink,
  ).registrar();

  // -- rotas ------------------------------------------------------------------

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', versao: '2.4.1', uptime: process.uptime() });
  });

  app.get('/drivers', assincrono(async (req, res) => {
    const cityId = num(req.query.cityId, 1);
    const limite = Math.min(num(req.query.limit, 50), 200);

    // cache de processo pra nao bater no banco toda hora (ver utils.CACHE)
    const ck = chave('drivers', cityId, limite);
    const cached = pegar(ck);
    if (cached && Date.now() - cached.em < 2000) {
      res.json(cached.body);
      return;
    }
    const linhas = await consultar(
      'SELECT id_driver, name, city_id, category, vehicle_plate, vehicle_model, rating FROM drivers WHERE city_id = ? AND documents_ok = 1 ORDER BY id_driver LIMIT ?',
      [cityId, limite],
    );
    const body = { cityId, total: linhas.length, drivers: linhas };
    guardar(ck, { em: Date.now(), body });
    res.json(body);
  }));

  app.get('/drivers/online', assincrono(async (req, res) => {
    const cityId = num(req.query.cityId, 1);
    const motoristas = await driverService.listarOnline(cityId);
    res.json({ cityId, total: motoristas.length, motoristas });
  }));

  app.get('/trips', assincrono(async (req, res) => {
    const cityId = num(req.query.cityId, 1);
    const limite = Math.min(num(req.query.limit, 25), 100);
    res.json({ cityId, corridas: await tripService.listar(cityId, limite) });
  }));

  app.get('/trips/resumo', assincrono(async (req, res) => {
    res.json(await tripService.resumo(num(req.query.cityId, 1)));
  }));

  app.get('/trips/:reference', assincrono(async (req, res) => {
    const corrida = await tripService.detalhar(req.params.reference);
    if (!corrida) {
      res.status(404).json({ erro: 'corrida não encontrada' });
      return;
    }
    res.json(corrida);
  }));

  app.get('/drivers/:id/trips', assincrono(async (req, res) => {
    const limite = Math.min(num(req.query.limit, 20), 100);
    res.json({ corridas: await tripService.historicoDoMotorista(num(req.params.id, 0), limite) });
  }));

  app.post('/pricing/estimate', (req, res) => {
    const estimativa = pricingService.estimar({
      cidade: num(req.body?.cidade, 1),
      categoria: String(req.body?.categoria ?? 'standard'),
      zona: req.body?.zona,
      distanciaM: num(req.body?.distanciaM, 3000),
      duracaoS: num(req.body?.duracaoS, 600),
      bandeira: req.body?.bandeira,
    });
    if (!estimativa) {
      res.status(422).json({ erro: 'sem faixa tarifária aplicável' });
      return;
    }
    res.json(estimativa);
  });

  app.get('/geocoding/reverse', assincrono(async (req, res) => {
    const endereco = await geocodingService.reverso(
      num(req.query.lat, -21.3767),
      num(req.query.lng, -46.5253),
    );
    res.json({ endereco });
  }));

  app.get('/telemetry', (_req, res) => {
    res.json({
      sessao: telemetryService.relatorio(),
      exportacao: telemetryExporter.relatorio(),
      uploaderVendor: uploaderVendor.status(),
    });
  });

  app.get('/simulacao/estado', assincrono(async (_req, res) => {
    res.json(await simulacaoService.estado());
  }));

  app.post('/simulacao/iniciar', assincrono(async (req, res) => {
    const cidade = num(req.body?.cidade, config.frota.cidadePadrao);
    const motoristas = num(req.body?.motoristas, config.frota.tamanho);
    res.json(await simulacaoService.iniciar(cidade, motoristas));
  }));

  app.post('/simulacao/parar', assincrono(async (_req, res) => {
    res.json(await simulacaoService.parar());
  }));

  // Precisa vir depois de todas as rotas: middleware de erro do Express
  // (assinatura de 4 parametros). Sem isso, um erro que passa por
  // assincrono() ainda derrubaria o processo -- agora vira uma resposta
  // 500 normal, e o processo continua de pe pras outras requisicoes.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('erro nao tratado numa rota', err);
    res.status(500).json({ erro: 'erro interno' });
  });

  servidor.listen(config.port, () => {
    logger.info(`API ouvindo na porta ${config.port}`);
    void painelService.iniciar(config.frota.cidadePadrao);
  });
}

bootstrap().catch((erro) => {
  logger.error('falha no bootstrap', erro);
  process.exit(1);
});
