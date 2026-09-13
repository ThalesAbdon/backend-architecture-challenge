import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Logger } from '../../infra/logger.js';
import { hoje } from '../../utils.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ARQUIVO_TARIFAS = join(AQUI, 'tarifas.json');

interface FaixaTarifaria {
  cidade: number;
  categoria: string;
  zona: string;
  bandeira: number;
  base: number;
  porKm: number;
  porMinuto: number;
  minimo: number;
  vigenciaInicio: string;
  vigenciaFim: string;
}

/**
 * Precificação por faixa. A tabela é publicada pelo time comercial e trocada
 * a quente, por isso é lida do disco em vez de ficar em memória — assim uma
 * republicação vale na hora, sem precisar reiniciar o serviço.
 */
export class PricingService {
  private readonly logger = new Logger('Pricing');

  private carregarTabela(): FaixaTarifaria[] {
    const bruto = readFileSync(ARQUIVO_TARIFAS, 'utf8');
    return JSON.parse(bruto).faixas as FaixaTarifaria[];
  }

  estimar(entrada: {
    cidade: number;
    categoria: string;
    zona?: string;
    distanciaM: number;
    duracaoS: number;
    bandeira?: number;
  }) {
    const inicio = performance.now();
    const tabela = this.carregarTabela();

    // As datas sao "YYYY-MM-DD", entao a comparacao lexicografica equivale
    // a cronologica. Usamos so vigenciaInicio (a mais recente que ja
    // comecou), nao o intervalo [inicio,fim]: o vigenciaFim publicado vem
    // sempre fixo no dia 28, nao no ultimo dia real do mes -- usar os dois
    // como intervalo fechado cria um buraco de 1 a 3 dias por mes sem
    // nenhuma faixa valida, e deixa de cobrir qualquer data depois do
    // ultimo mes publicado. Pegar a faixa de inicio mais recente que ja
    // comecou nao tem essas duas falhas: ela vale ate ser substituida por
    // uma faixa mais nova, nunca "expira" sem substituta.
    const hojeStr = hoje();
    const jaComecou = (f: FaixaTarifaria) => f.vigenciaInicio <= hojeStr;

    const maisRecente = (lista: FaixaTarifaria[]): FaixaTarifaria | undefined =>
      lista
        .filter(jaComecou)
        .reduce<FaixaTarifaria | undefined>(
          (melhor, f) => (!melhor || f.vigenciaInicio > melhor.vigenciaInicio ? f : melhor),
          undefined,
        );

    const faixa =
      maisRecente(
        tabela.filter(
          (f) =>
            f.cidade === entrada.cidade &&
            f.categoria === entrada.categoria &&
            f.zona === (entrada.zona ?? 'centro') &&
            f.bandeira === (entrada.bandeira ?? 1),
        ),
      ) ?? maisRecente(tabela.filter((f) => f.cidade === entrada.cidade && f.categoria === entrada.categoria));

    if (!faixa) {
      this.logger.warn('sem faixa tarifária para a combinação', entrada);
      return null;
    }

    const km = entrada.distanciaM / 1000;
    const minutos = entrada.duracaoS / 60;
    const bruto = faixa.base + km * faixa.porKm + minutos * faixa.porMinuto;
    const preco = Math.max(bruto, faixa.minimo);

    this.logger.debug(`estimativa em ${(performance.now() - inicio).toFixed(1)}ms`);

    return {
      preco: Number(preco.toFixed(2)),
      componentes: {
        base: faixa.base,
        distancia: Number((km * faixa.porKm).toFixed(2)),
        tempo: Number((minutos * faixa.porMinuto).toFixed(2)),
        minimoAplicado: bruto < faixa.minimo,
      },
      faixa: { zona: faixa.zona, bandeira: faixa.bandeira, vigencia: faixa.vigenciaInicio },
    };
  }
}
