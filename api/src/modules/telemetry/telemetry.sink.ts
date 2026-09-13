import type { AmostraPosicao } from './telemetry.types.js';
import type { TelemetryExporter } from './telemetry.exporter.js';

interface FleetLinkUploader {
  push: (amostra: AmostraPosicao) => Promise<boolean>;
}

export interface TelemetrySink {
  enviar(amostra: AmostraPosicao): void;
}

export class FleetLinkTelemetrySink implements TelemetrySink {
  constructor(
    private readonly uploader: FleetLinkUploader,
  ) {}

  enviar(amostra: AmostraPosicao): void {
    void this.uploader.push(amostra);
  }
}

export class LocalTelemetrySink implements TelemetrySink {
  constructor(
    private readonly exporter: TelemetryExporter,
  ) {}

  enviar(amostra: AmostraPosicao): void {
    this.exporter.capturar(amostra);
  }
}