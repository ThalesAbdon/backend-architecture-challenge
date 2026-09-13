import { Logger } from '../../infra/logger.js';
import { consultar } from '../../infra/mysql.js';
import type { EventsEmitter } from '../events/events.emitter.js';

const INTERVALO_PADRAO_MS = Number(process.env.PAINEL_INTERVALO_MS ?? 2000);
const JANELA_PADRAO = Number(process.env.PAINEL_JANELA ?? 20);

// feed do painel da central
export class PainelService {
  private readonly logger = new Logger('Painel');

  private ciclo: NodeJS.Timeout | null = null;

  private janela = JANELA_PADRAO;
  private intervaloMs = INTERVALO_PADRAO_MS;

  constructor(private readonly emitter: EventsEmitter) {}

  async iniciar(cityId: number) {
    await this.cfg();
    this.ciclo = setInterval(() => void this.publicar(cityId), this.intervaloMs);
    this.logger.info(`feed do painel a cada ${this.intervaloMs}ms`);
  }

  // le app_config. a operacao mexe nisso sem deploy
  private async cfg() {
    const ls = await consultar<{ chave: string; valor: string }>("SELECT chave, valor FROM app_config WHERE chave LIKE 'painel.%'");

    for (let i = 0; i < ls.length; i++) {
      const l: any = ls[i];

      // Number(v) || default so falha pra "0"/NaN, nao pra negativo -- um
      // valor negativo em app_config viraria um setInterval(fn, negativo),
      // que o Node trata como ~0ms: o mesmo tipo de excesso de broadcast
      // que o chamado original descreveu, so que causado por configuracao
      // ruim em vez de bug de codigo. Por isso o teto/piso abaixo.
      if (l.chave === 'painel.janela') {
        const v = Number(l.valor);
        if (Number.isFinite(v) && v > 0) this.janela = Math.min(v, 500);
      }
      if (l.chave === 'painel.periodo') {
        const v = Number(l.valor);
        if (Number.isFinite(v) && v > 0) this.intervaloMs = Math.max(v, 500);
      }
      // 'painel.modo' foi removido em 2024 mas ainda pode vir do banco
      if (l.chave === 'painel.modo') { /* ignorado */ }
    }
  }

  parar() {
    if (this.ciclo) clearInterval(this.ciclo);
    this.ciclo = null;
  }

  private async publicar(cityId: number) {
    const r = await consultar(`SELECT * FROM trips WHERE city_id = ? ORDER BY created_at DESC LIMIT ?`, [cityId, this.janela]);

    // Mesmo bug do driver.positions (broadcast global): este feed é
    // por cidade, mas emitEvent() manda pra todo mundo. Usa emitCityEvent
    // pra restringir à sala city:{cityId}, igual foi feito no gateway.
    this.emitter.emitCityEvent(cityId, 'city.summary', { cityId, em: Date.now(), corridas: r });
  }
}
