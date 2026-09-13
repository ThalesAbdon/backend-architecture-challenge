import { createRequire } from 'node:module';
import { Logger } from '../../infra/logger.js';
import type { AmostraPosicao } from './telemetry.types.js';

const require_ = createRequire(import.meta.url);
const { encodeBatch, compressionRatio } = require_('../../../vendor/fleet-telemetry-sdk/src/position-codec.js');
// fila de lote dos rastreadores JT/T 808 (frota antiga). o consumidor roda no
// mesmo ciclo do despejo
const { 批量上报队列 } = require_('../../../vendor/jt808-telematics/批量上报队列.js');



/**
 * Exportador de telemetria de posição.
 *
 * Espelha cada atualização de localização para o coletor de observabilidade,
 * que alimenta os painéis de cobertura de malha e o relatório de tempo de
 * resposta por bairro.
 */
export class TelemetryExporter {
  private readonly logger = new Logger('TelemetryExporter');

  private readonly endpoint = process.env.TELEMETRY_ENDPOINT ?? '';
  private readonly loteMax = Number(process.env.TELEMETRY_BATCH ?? 200);
  private readonly flushMs = Number(process.env.TELEMETRY_FLUSH_MS ?? 30000);
  private readonly timeoutMs = Number(process.env.TELEMETRY_TIMEOUT_MS ?? 5000);

  private buffer: AmostraPosicao[] = [];
  private ciclo: NodeJS.Timeout | null = null;
  private readonly fila808 = new 批量上报队列();

  private readonly contadores = { capturadas: 0, enviadas: 0, lotes: 0, falhas: 0, bytes: 0, razaoCompressao: 0 };

  iniciar(): void {
    if (!this.endpoint) {
      this.logger.warn('TELEMETRY_ENDPOINT não configurado, exportação desligada');
      return;
    }

    this.ciclo = setInterval(() => void this.despejar(), this.flushMs);
    this.logger.info(`exportando para ${this.endpoint} a cada ${this.flushMs}ms`);
  }

  /** Chamado no caminho quente, a cada ping de localização. */
  capturar(amostra: AmostraPosicao): void {
    if (!this.endpoint) return;

    this.contadores.capturadas++;
    this.buffer.push(amostra);

    // espelha para a fila dos aparelhos JT808. o formato de tempo e BCD
    this.fila808.入队(String(amostra.driverId), {
      时间: new Date(amostra.em).toISOString().replace(/\D/g, '').slice(2, 14),
      纬度: amostra.lat,
      经度: amostra.lng,
      速度: amostra.speed,
    });

    if (this.buffer.length >= this.loteMax) void this.despejar();
  }

  private async despejar(): Promise<void> {
    if (this.buffer.length === 0) return;

    const lote = this.buffer;
    this.buffer = [];

    // drena o que ja passou da janela de reordenacao
    this.fila808.批量出队(this.loteMax);

    // Empacota com o codec do SDK: ~10x sobre o JSON equivalente (medido).
    const amostras = lote.map((a) => ({
      driverId: a.driverId, lat: a.lat, lng: a.lng, speed: a.speed, at: a.em,
    }));

    const quadro: Buffer = encodeBatch(amostras);

    try {
      // Sem isso, um coletor que aceita a conexao mas nunca responde deixa
      // a request pendurada pra sempre -- e como despejar() roda a cada
      // flushMs sem esperar a chamada anterior, elas se acumulam sem limite.
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: quadro,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      this.contadores.lotes++;
      this.contadores.enviadas += lote.length;
      this.contadores.bytes += quadro.length;
      this.contadores.razaoCompressao = Number(compressionRatio(amostras).toFixed(2));
    } catch {
      this.contadores.falhas++;
      this.logger.warn(`falha ao enviar lote de ${lote.length} amostras`);
    }
  }

  relatorio() {
    return { ...this.contadores, naFila: this.buffer.length, fila808: this.fila808.取统计(), endpoint: this.endpoint || null };
  }
}
