import type { Server, Socket } from 'socket.io';
import { Logger } from '../../infra/logger.js';
import { EventsEmitter } from './events.emitter.js';
import { EventsRoomService, Sala } from './events.rooms.js';
import type {
  DriverService,
  AtualizacaoPosicaoDto,
} from '../driver/driver.service.js';
import type { TelemetryService } from '../telemetry/telemetry.service.js';
import type { TelemetrySink } from '../telemetry/telemetry.sink.js';

// Contadores de sessão.
let totalConn = 0;
let totalDisc = 0;
let ultimoErro: unknown = null;

// Intervalo máximo entre atualizações do mapa.
// Os pings continuam chegando normalmente.
const BROADCAST_INTERVAL_MS = 200;

// Cidades que receberam alguma alteração desde o último flush.
const cidadesPendentes = new Set<number>();

let broadcastTimer: NodeJS.Timeout | null = null;

export class EventsGateway {
  private readonly logger = new Logger('EventsGateway');

  constructor(
    private readonly io: Server,
    private readonly emitter: EventsEmitter,
    private readonly salas: EventsRoomService,
    private readonly driverService: DriverService,
    private readonly telemetria: TelemetryService,
    private readonly telemetrySink: TelemetrySink,
  ) {}

  registrar(): void {
    this.emitter.setServer(this.io);

    this.io.on('connection', (client) => {
      void this.aoConectar(client);
    });

    this.iniciarBroadcastLoop();

    this.logger.info('gateway de tempo real pronto');
  }

  /**
   * Marca uma cidade como pendente de atualização.
   *
   * O Set evita que vários pings da mesma cidade
   * gerem vários broadcasts.
   */
  private marcarCidadePendente(cityId: number): void {
    if (!Number.isFinite(cityId)) {
      return;
    }

    cidadesPendentes.add(cityId);
  }

  /**
   * Inicia o loop responsável pelos broadcasts.
   *
   * Em vez de:
   *
   *   ping -> broadcast
   *
   * fazemos:
   *
   *   vários pings -> cidade pendente
   *   -> broadcast agrupado
   */
  private iniciarBroadcastLoop(): void {
    if (broadcastTimer) {
      return;
    }

    broadcastTimer = setInterval(() => {
      void this.processarBroadcastsPendentes();
    }, BROADCAST_INTERVAL_MS);
  }

  private async processarBroadcastsPendentes(): Promise<void> {
    if (cidadesPendentes.size === 0) {
      return;
    }

    const cidades = Array.from(cidadesPendentes);

    cidadesPendentes.clear();

    for (const cityId of cidades) {
      try {
        await this.emitter.emitDriverLocations(cityId);
      } catch (e) {
        this.logger.error(
          `erro ao atualizar motoristas da cidade ${cityId}`,
          e,
        );

        /**
         * Se falhou, recoloca a cidade no Set para tentar
         * novamente no próximo ciclo.
         */
        this.marcarCidadePendente(cityId);
      }
    }
  }

  private async aoConectar(client: Socket): Promise<void> {
    const q = client.handshake.query as Record<string, string>;

    const driverId = q.driverId;
    const userId = q.userId;
    const cityId = q.cityId;
    const tripReference = q.tripReference;

    totalConn++;

    this.telemetria.acompanhar(client);

    /**
     * Conexão de usuário normal.
     */
    if (userId) {
      this.salas.entrar(
        client,
        Sala.usuario(userId),
      );
    } else if (!driverId) {
      this.logger.debug(
        `conexao sem identificacao ${client.id}`,
      );
    }

    /**
     * Sala de cidade informada pelo cliente.
     */
    if (cityId) {
      this.salas.entrar(
        client,
        Sala.cidade(cityId),
      );
    }

    /**
     * Sala de corrida.
     */
    if (tripReference) {
      this.salas.entrar(
        client,
        Sala.corrida(tripReference),
      );
    }

    /**
     * Conexão de motorista.
     */
    if (driverId) {
      const d = Number(driverId);

      if (!Number.isFinite(d)) {
        this.emitter.emitError(
          client,
          'connect',
          'driverId invalido',
          { driverId },
        );

        client.disconnect(true);
        return;
      }

      const lat = q.latitude;
      const lng = q.longitude;

      let p: Awaited<
        ReturnType<DriverService['conectar']>
      > = null;

      try {
        p = await this.driverService.conectar(
          d,
          client.id,
          {
            latitude: Number(lat) || 0,
            longitude: Number(lng) || 0,
          },
        );
      } catch (e) {
        ultimoErro = e;

        this.logger.error(
          `erro ao conectar motorista ${d}`,
          e,
        );
      }

      if (!p) {
        this.emitter.emitError(
          client,
          'connect',
          'motorista indisponivel para conexao',
          {
            driverId: d,
          },
        );

        client.disconnect(true);
        return;
      }

      /**
       * Salas específicas do motorista.
       */
      this.salas.entrar(
        client,
        Sala.motorista(d),
      );

      this.salas.entrar(
        client,
        Sala.cidade(p.cityId),
      );

      /**
       * A primeira conexão precisa aparecer imediatamente.
       *
       * Não esperamos os 200ms do loop.
       */
      try {
        await this.emitter.emitDriverLocations(
          p.cityId,
        );
      } catch (e) {
        this.logger.error(
          `erro ao publicar conexao do motorista ${d}`,
          e,
        );

        this.marcarCidadePendente(
          p.cityId,
        );
      }

      this.logger.info(
        `motorista ${d} conectado (${client.id})`,
      );
    }

    /**
     * Atualização de posição.
     */
    client.on(
      'driver.location',
      (dto: AtualizacaoPosicaoDto) => {
        void this.aoReceberPosicao(
          client,
          dto,
        );
      },
    );

    /**
     * Entrada em sala.
     */
    client.on(
      'join-room',
      (dados: { sala: string }) => {
        this.salas.entrar(
          client,
          dados?.sala,
        );
      },
    );

    /**
     * Saída de sala.
     */
    client.on(
      'leave-room',
      (dados: { sala: string }) => {
        this.salas.sair(
          client,
          dados?.sala,
        );
      },
    );

    /**
     * Desconexão.
     */
    client.on(
      'disconnect',
      () => {
        void this.aoDesconectar(client);
      },
    );
  }

  /**
   * Recebe ping do motorista.
   *
   * O ping:
   *
   * 1. valida
   * 2. atualiza Redis
   * 3. envia telemetria
   * 4. marca a cidade
   *
   * Não faz broadcast diretamente.
   */
  private async aoReceberPosicao(
    client: Socket,
    dto: AtualizacaoPosicaoDto,
  ): Promise<void> {
    if (
      !dto?.driverId ||
      dto.latitude == null ||
      dto.longitude == null
    ) {
      this.emitter.emitError(
        client,
        'driver.location',
        'parametros invalidos',
        dto,
      );

      return;
    }

    try {
      const pos =
        await this.driverService.atualizarPosicao(
          dto,
          client.id,
        );

      if (!pos) {
        return;
      }

      /**
       * Amostra de telemetria.
       *
       * NÃO alterar os nomes das propriedades.
       */
      const a = {
        driverId: pos.driverId,
        cityId: pos.cityId,
        lat: pos.latitude,
        lng: pos.longitude,
        speed: pos.speed,
        accuracy: pos.accuracy,
        em: Date.now(),
      };

      this.telemetrySink.enviar(a);

      /**
       * Não fazemos broadcast aqui.
       *
       * O loop vai agrupar vários pings.
       */
      this.marcarCidadePendente(
        pos.cityId,
      );
    } catch (e) {
      this.logger.error(
        `erro ao atualizar posicao do motorista ${Number(dto.driverId)}`,
        e,
      );
    }
  }

  /**
   * Trata desconexão.
   *
   * O socket é passado até o repository para garantir
   * que um socket antigo não remova uma sessão nova.
   */
  private async aoDesconectar(
    client: Socket,
  ): Promise<void> {
    totalDisc++;

    try {
      const p =
        await this.driverService.localizarPorSocket(
          client.id,
        );

      /**
       * Não existe mais sessão associada a esse socket.
       *
       * Isso pode acontecer quando:
       *
       * - a sessão já expirou;
       * - o socket antigo perdeu para uma reconexão;
       * - o índice Redis já foi removido.
       */
      if (!p) {
        this.salas.sairDeTodas(client);
        return;
      }

      /**
       * Remove somente se esse socket ainda for
       * o dono da sessão.
       */
      const removida =
        await this.driverService.desconectar(
          p.driverId,
          client.id,
        );

      /**
       * Se null:
       *
       * socket antigo != socket atual
       *
       * Portanto o motorista continua online.
       */
      if (!removida) {
        this.salas.sairDeTodas(client);
        return;
      }

      /**
       * A remoção realmente aconteceu.
       *
       * Marcamos a cidade para o próximo broadcast.
       */
      this.marcarCidadePendente(
        p.cityId,
      );

      this.logger.info(
        `motorista ${p.driverId} desconectado`,
      );

      this.salas.sairDeTodas(client);
    } catch (e) {
      this.logger.error(
        `erro ao desconectar socket ${client.id}`,
        e,
      );

      this.salas.sairDeTodas(client);
    }
  }

  /**
   * Usado pelo /health de uma versão antiga.
   * Mantido por compatibilidade.
   */
  stats() {
    return {
      totalConn,
      totalDisc,
      ultimoErro: ultimoErro
        ? String(ultimoErro)
        : null,
    };
  }
}