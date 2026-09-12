import { redis } from '../../infra/redis.js';
import { consultar } from '../../infra/mysql.js';
import { config } from '../../config.js';
import { Logger } from '../../infra/logger.js';
import type { MotoristaPosicao, MotoristaRow } from './driver.types.js';

const PREFIXO_POSICAO = 'driver:pos:';
const PREFIXO_CIDADE = 'driver:city:';
const PREFIXO_SOCKET = 'driver:socket:';

export class DriverRepository {
  private readonly logger = new Logger('DriverRepository');

  async buscarCadastro(driverId: number): Promise<MotoristaRow | null> {
    const linhas = await consultar<MotoristaRow>(
      'SELECT * FROM drivers WHERE id_driver = ? LIMIT 1',
      [driverId],
    );

    return linhas[0] ?? null;
  }

  async salvarPosicao(posicao: MotoristaPosicao): Promise<void> {
    const cliente = redis();

    const chavePosicao = `${PREFIXO_POSICAO}${posicao.driverId}`;
    const chaveCidade = `${PREFIXO_CIDADE}${posicao.cityId}`;
    const chaveSocket = `${PREFIXO_SOCKET}${posicao.socketClientId}`;

    const agora = Math.floor(Date.now() / 1000);

    await cliente
      .multi()
      .set(
        chavePosicao,
        JSON.stringify(posicao),
        {
          EX: config.posicaoTtl,
        },
      )
      .set(
        chaveSocket,
        String(posicao.driverId),
        {
          EX: config.posicaoTtl,
        },
      )
      .zAdd(chaveCidade, {
        score: agora,
        value: String(posicao.driverId),
      })
      .exec();
  }

  /**
   * Remove a posição somente se o socket informado ainda for
   * o dono da sessão atual do motorista.
   *
   * Isso evita o problema:
   *
   * socket antigo desconecta
   *        ↓
   * motorista já reconectou
   *        ↓
   * socket novo está salvo no Redis
   *        ↓
   * disconnect antigo NÃO pode apagar a sessão nova
   */
  async removerPosicao(
    driverId: number,
    socketClientId: string,
  ): Promise<MotoristaPosicao | null> {
    const cliente = redis();

    const chavePosicao = `${PREFIXO_POSICAO}${driverId}`;
    const chaveSocket = `${PREFIXO_SOCKET}${socketClientId}`;

    const bruto = await cliente.get(chavePosicao);

    if (!bruto) {
      // Limpa o índice do socket mesmo que a posição já tenha expirado.
      await cliente.del(chaveSocket);
      return null;
    }

    let posicao: MotoristaPosicao;

    try {
      posicao = JSON.parse(bruto) as MotoristaPosicao;
    } catch {
      this.logger.warn(
        `registro de posicao corrompido para motorista ${driverId}`,
      );

      await cliente.del(chavePosicao);
      await cliente.del(chaveSocket);

      return null;
    }

    /*
     * CRÍTICO:
     *
     * Se o socket que está desconectando não é mais o socket
     * registrado para o motorista, não removemos a sessão atual.
     */
    if (posicao.socketClientId !== socketClientId) {
      return null;
    }

    const chaveCidade = `${PREFIXO_CIDADE}${posicao.cityId}`;

    await cliente
      .multi()
      .del(chavePosicao)
      .del(chaveSocket)
      .zRem(
        chaveCidade,
        String(driverId),
      )
      .exec();

    return posicao;
  }

  async buscarPosicao(
    driverId: number,
  ): Promise<MotoristaPosicao | null> {
    const bruto = await redis().get(
      `${PREFIXO_POSICAO}${driverId}`,
    );

    if (!bruto) {
      return null;
    }

    try {
      return JSON.parse(bruto) as MotoristaPosicao;
    } catch {
      this.logger.warn(
        `registro de posicao corrompido para motorista ${driverId}`,
      );

      await redis().del(
        `${PREFIXO_POSICAO}${driverId}`,
      );

      return null;
    }
  }

  /**
   * Lista os motoristas online de uma cidade.
   *
   * Não usa KEYS.
   *
   * O Sorted Set driver:city:<cityId> funciona como índice
   * dos motoristas daquela cidade.
   */
  async listarOnline(
    cityId: number,
  ): Promise<MotoristaPosicao[]> {
    const cliente = redis();

    const chaveCidade = `${PREFIXO_CIDADE}${cityId}`;

    const agora = Math.floor(Date.now() / 1000);
    const limite = agora - config.posicaoTtl;

    /*
     * Remove do índice os motoristas que não atualizaram
     * a posição dentro do TTL.
     */
    await cliente.zRemRangeByScore(
      chaveCidade,
      0,
      limite,
    );

    const ids = await cliente.zRange(
      chaveCidade,
      0,
      -1,
    );

    if (ids.length === 0) {
      return [];
    }

    const chaves = ids.map(
      (id) => `${PREFIXO_POSICAO}${id}`,
    );

    const valores = await cliente.mGet(chaves);

    const out: MotoristaPosicao[] = [];

    for (let i = 0; i < valores.length; i++) {
      const bruto = valores[i];

      if (!bruto) {
        /*
         * A posição pode ter expirado entre o zRange
         * e o mGet.
         */
        continue;
      }

      try {
        const posicao = JSON.parse(
          bruto,
        ) as MotoristaPosicao;

        /*
         * Proteção adicional contra inconsistência do índice.
         */
        if (posicao.cityId !== cityId) {
          continue;
        }

        out.push(posicao);
      } catch {
        this.logger.warn(
          `registro de posicao corrompido no cache da cidade ${cityId}`,
        );
      }
    }

    return out;
  }

  /**
   * Localiza diretamente o motorista pelo socket.
   *
   * Não usa KEYS nem varre a frota inteira.
   *
   * driver:socket:<socketId> -> driverId
   * driver:pos:<driverId>   -> posição completa
   */
  async localizarPorSocket(
    socketClientId: string,
  ): Promise<MotoristaPosicao | null> {
    const cliente = redis();

    const driverId = await cliente.get(
      `${PREFIXO_SOCKET}${socketClientId}`,
    );

    if (!driverId) {
      return null;
    }

    return this.buscarPosicao(
      Number(driverId),
    );
  }
}