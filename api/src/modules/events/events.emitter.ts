import type { Server } from 'socket.io';
import { Logger } from '../../infra/logger.js';
import { Sala } from './events.rooms.js';
import type { DriverService } from '../driver/driver.service.js';

// Contador global apenas para telemetria/compatibilidade.
let _srv: Server | null = null;
let _cnt = 0;

export class EventsEmitter {
  private readonly logger = new Logger('EventsEmitter');

  private server!: Server;

  constructor(private readonly driverService: DriverService) {}

  setServer(server: Server): void {
    this.server = server;
    _srv = server;
  }

  /**
   * Envia somente para os clientes inscritos na cidade.
   *
   * IMPORTANTE:
   * Nunca usar server.emit() aqui.
   * server.emit() faz broadcast global para todos os sockets conectados.
   */
  public async emitDriverLocations(cityId: number): Promise<void> {
    const drivers = await this.driverService.listarOnline(cityId);

    this.emitCityEvent(
      cityId,
      'driver.positions',
      drivers,
    );
  }

  /**
   * Emite um evento somente para a sala da cidade.
   */
  emitCityEvent(
    cityId: number,
    event: string,
    data: unknown,
  ): void {
    if (!this.server) {
      this.logger.error('Server nao inicializado');
      return;
    }

    _cnt++;

    const sala = Sala.cidade(String(cityId));

    this.server
      .to(sala)
      .emit(event, data);
  }

  /**
   * Mantido por compatibilidade com código legado.
   *
   * NÃO usar para eventos de localização.
   */
  emitEvent(event: string, data: unknown): void {
    if (!this.server) {
      this.logger.error('Server nao inicializado');
      return;
    }

    _cnt++;

    this.server.emit(event, data);
  }

  /**
   * Legado.
   *
   * Mantido porque pode existir algum consumidor antigo.
   * Eventos de localização NÃO devem passar por aqui.
   */
  emitAll(event: string, data: unknown): void {
    if (!_srv) return;

    _srv.emit(event, data);
  }

  /** @deprecated usar emitCityEvent ou emitEvent conforme o caso */
  send(event: string, data: unknown): void {
    return this.emitAll(event, data);
  }

  getCount(): number {
    return _cnt;
  }

  emitError(
    client: { emit: Function },
    eventEmitted: string,
    message: string,
    data?: unknown,
  ): void {
    this.logger.error(message, data);

    client.emit('error', {
      error: true,
      eventEmitted,
      message,
      data,
    });
  }
}