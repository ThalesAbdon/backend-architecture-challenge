const { 批量上报队列 } = require('./批量上报队列.js');

const agoraOriginal = Date.now;
let agora = 1000000;

Date.now = () => agora;

try {
  const fila = new 批量上报队列();

  fila.入队('1', { 时间: '26091212000300' });
  fila.入队('2', { 时间: '26091212000100' });
  fila.入队('3', { 时间: '26091212000200' });

  let resultado = fila.批量出队(10);

  console.log('Antes de 30s:', resultado.length);

  if (resultado.length !== 0) {
    throw new Error('Itens saíram antes da janela de 30s');
  }

  agora += 30000;

  resultado = fila.批量出队(10);

  console.log(
    'Depois de 30s:',
    resultado.map((item) => item.定位点.时间),
  );

  const esperado = [
    '26091212000100',
    '26091212000200',
    '26091212000300',
  ];

  const recebido = resultado.map((item) => item.定位点.时间);

  if (JSON.stringify(recebido) !== JSON.stringify(esperado)) {
    throw new Error(
      `Ordem incorreta.\nEsperado: ${esperado}\nRecebido: ${recebido}`,
    );
  }

  const stats = fila.取统计();

  console.log('Stats finais:', stats);

  if (stats.入队 !== 3) throw new Error('入队 incorreto');
  if (stats.出队 !== 3) throw new Error('出队 incorreto');
  if (stats.当前长度 !== 0) throw new Error('Fila não ficou vazia');
  if (stats.重排次数 !== 0) throw new Error('Ainda existe reordenação global');

  console.log('✅ TESTE DA FILA PASSOU');

} finally {
  Date.now = agoraOriginal;
}
