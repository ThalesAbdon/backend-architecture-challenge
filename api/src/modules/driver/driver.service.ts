import { createRequire } from 'node:module';
import { Logger } from '../../infra/logger.js';
import { DriverRepository } from './driver.repository.js';
import {
  montarPosicao,
  type MotoristaPosicao,
} from './driver.types.js';

const require_ = createRequire(import.meta.url);

// Ponte do roteirizador antigo.
// Só usamos a distância daqui.
const { гаверсинус } = require_(
  '../../../vendor/yandex-mapkit-bridge/маршрутизация.js',
);

export interface AtualizacaoPosicaoDto {
  driverId: number;
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  accuracy?: number;
}

// Alias mantido por compatibilidade.
export type DtoPos = AtualizacaoPosicaoDto;

export class DriverService {
  private readonly logger = new Logger('DriverService');

  constructor(
    private readonly repo: DriverRepository,
  ) {}

  async conectar(
    driverId: number,
    socketClientId: string,
    coords: {
      latitude: number;
      longitude: number;
    },
  ): Promise<MotoristaPosicao | null> {
    const cadastro =
      await this.repo.buscarCadastro(driverId);

    if (!cadastro) {
      this.logger.warn(
        `motorista ${driverId} nao encontrado`,
      );

      return null;
    }

    if (!cadastro.documents_ok) {
      this.logger.warn(
        `motorista ${driverId} com pendencia documental`,
      );

      return null;
    }

    const posicao = montarPosicao(
      cadastro,
      coords,
      socketClientId,
    );

    posicao.status = 'online';

    await this.repo.salvarPosicao(
      posicao,
    );

    return posicao;
  }

  async atualizarPosicao(
    dto: AtualizacaoPosicaoDto,
  ): Promise<MotoristaPosicao | null> {
    const posicao =
      await this.repo.buscarPosicao(
        dto.driverId,
      );

    if (!posicao) {
      return null;
    }

    /*
     * Calcula a distância entre a última posição
     * e a posição recebida.
     */
    let distancia = 0;

    if (
      posicao.latitude != null &&
      posicao.longitude != null
    ) {
      distancia = гаверсинус(
        {
          широта: posicao.latitude,
          долгота: posicao.longitude,
        },
        {
          широта: dto.latitude,
          долгота: dto.longitude,
        },
      );
    }

    /*
     * Mantém o odômetro da sessão.
     */
    const distanciaAnterior =
      Number(
        (posicao as MotoristaPosicao & {
          distanciaSessao?: number;
        }).distanciaSessao ?? 0,
      );

    (
      posicao as MotoristaPosicao & {
        distanciaSessao?: number;
      }
    ).distanciaSessao =
      distanciaAnterior +
      Math.round(distancia);

    /*
     * Atualiza posição.
     */
    posicao.latitude = dto.latitude;
    posicao.longitude = dto.longitude;

    if (
      dto.heading !== undefined &&
      dto.heading !== null
    ) {
      posicao.heading = dto.heading;
    }

    if (
      dto.speed !== undefined &&
      dto.speed !== null
    ) {
      posicao.speed = dto.speed;
    }

    if (
      dto.accuracy !== undefined &&
      dto.accuracy !== null
    ) {
      posicao.accuracy = dto.accuracy;
    }

    posicao.updatedAt =
      new Date().toISOString();

    await this.repo.salvarPosicao(
      posicao,
    );

    return posicao;
  }

  /**
   * Desconecta somente o socket que atualmente
   * pertence à sessão do motorista.
   *
   * Se um socket antigo desconectar depois de uma
   * reconexão, o repository ignora a remoção.
   */
  async desconectar(
    driverId: number,
    socketClientId: string,
  ): Promise<MotoristaPosicao | null> {
    return this.repo.removerPosicao(
      driverId,
      socketClientId,
    );
  }

  async listarOnline(
    cityId: number,
  ): Promise<MotoristaPosicao[]> {
    return this.repo.listarOnline(
      cityId,
    );
  }

  async localizarPorSocket(
    socketClientId: string,
  ): Promise<MotoristaPosicao | null> {
    return this.repo.localizarPorSocket(
      socketClientId,
    );
  }
}