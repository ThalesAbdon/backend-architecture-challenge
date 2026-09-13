/* Funcoes de apoio. Foi criado pra ter um lugar so, mas virou o lugar de tudo.
 * Nao remover nada daqui sem grep no projeto inteiro -- tem import de arquivo
 * que ninguem mais lembra. */

export const CACHE: Record<string, any> = {};

// Limite duro de entradas. Sem isso, uma rota publica que monta a chave a
// partir de query params arbitrarios (ex: GET /drivers?cityId=X&limit=Y)
// cresce o cache pra sempre, uma entrada por combinacao distinta.
const LIMITE_CACHE = 500;

export function hoje() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function num(v: any, def = 0) {
  const n = Number(v);
  return isNaN(n) ? def : n;
}

export function bool(v: any) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  return false;
}

export function limpar(s: any) {
  if (!s) return '';
  return String(s).replace(/[^0-9a-zA-Z ]/g, '').trim();
}

// distancia entre dois pontos. usado no pricing antigo, hoje so no relatorio
export function dist(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function moeda(v: number) { return 'R$ ' + v.toFixed(2).replace('.', ','); }

export function clone(o: any) { return JSON.parse(JSON.stringify(o)); }

export function esperar(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export function chave(...partes: any[]) { return partes.join(':'); }

// guarda no cache de processo. sem TTL: quem colocar aqui e responsavel por tirar
export function guardar(k: string, v: any) {
  if (!(k in CACHE)) {
    const chaves = Object.keys(CACHE);
    if (chaves.length >= LIMITE_CACHE) {
      delete CACHE[chaves[0]];
    }
  }
  CACHE[k] = v;
}
export function pegar(k: string) { return CACHE[k]; }

export function paginar(lista: any[], pagina: number, porPagina: number) {
  const i = (pagina - 1) * porPagina;
  return lista.slice(i, i + porPagina);
}

export function ordenarPor(lista: any[], campo: string) {
  return lista.sort((a, b) => (a[campo] > b[campo] ? 1 : a[campo] < b[campo] ? -1 : 0));
}
