# Desafio prático — Engenheiro(a) de Software Sênior, Backend

> **Status:** Implementação concluída

Bem-vindo. Este repositório é um recorte controlado da nossa plataforma de

mobilidade: a API de tempo real, o banco de corridas e uma bancada visual que

simula motoristas em operação.

Seu trabalho começa com um chamado aberto pelo suporte.

---

## 📑 Sumário

* [O chamado](#o-chamado)
* [Subindo o ambiente](#subindo-o-ambiente)
* [O que esperamos da entrega](#o-que-esperamos-da-entrega)
* [Mapa do repositório](#mapa-do-repositório)
* [Diagnóstico e implementação](#diagnóstico-e-implementação)

  * [Etapa 1 — Telemetria](#etapa-1--telemetria)
  * [Etapa 2 — Gargalo na fila JT808](#etapa-2--gargalo-na-fila-jt808)
* [Decisões técnicas](#decisões-técnicas)
* [Validação](#validação)
* [Observabilidade](#observabilidade)
* [Conclusão](#conclusão)

---

# 📋 Enunciado original

## O chamado

> **Chamado #4471 — Suporte / Financeiro — prioridade alta**
>
> Motoristas de Muzambinho vêm reclamando que o aplicativo consome o pacote de
> dados deles.
>
> O financeiro sinalizou que a linha de saída de dados do provedor de
> infraestrutura subiu.
>
> Precisamos entender o que está acontecendo e o que fazer a respeito.

Ninguém sabe a causa. Faz parte do desafio descobrir.

---

## Subindo o ambiente

Requisitos: Docker e Docker Compose.

```bash
docker compose up -d --build
```

O ambiente está pronto quando a API responder:

```bash
curl -s localhost:3000/health
```

Nos primeiros segundos a API reinicia uma ou duas vezes com `ECONNREFUSED` no

MySQL — é esperado, o `restart: unless-stopped` cuida disso. O seed carrega

cerca de 100 mil corridas.

Portas usadas no host — precisam estar livres:

* **Bancada visual:** http://localhost:8080
* **API:** http://localhost:3000
* **Coletor de telemetria:** http://localhost:9000 — `/stats` e `/handshake`
* **MySQL:** `localhost:3306` — banco `mobilidade`, usuário `mobilidade`, senha `mobilidade`
* **Redis:** `localhost:6379`

Na bancada, o botão **Iniciar teste** conecta os 6 aparelhos e a frota de fundo.

Cada aparelho roda uma corrida completa de cerca de 40 segundos; a frota apenas

circula pela malha emitindo posição. Deixe rodar até o fim pelo menos uma vez

antes de tirar conclusões.

Sem apertar o botão, **nenhum motorista fica online** — a frota só conecta

quando a simulação é ativada.

Para derrubar tudo, inclusive os dados:

```bash
docker compose down -v
```

---

## O que esperamos da entrega

Um repositório Git com o seu trabalho e um `README.md` na raiz descrevendo:

* o diagnóstico
* as decisões tomadas

### Sobre uso de IA

Pode usar. Não vamos perguntar e não vamos penalizar.

O que avaliamos é a entrega e a sua capacidade de sustentá-la: na etapa

seguinte você vai conversar com a gente sobre as decisões deste repositório.

---

## Mapa do repositório

```text
docker-compose.yml   seis serviços: mysql, redis, api, coletor, frota, web

api/                  API Node.js — tempo real, corridas, precificação, telemetria
  src/                código da aplicação
  vendor/             integrações de terceiros com patch local

web/                  bancada visual (HTML/CSS/JS sem build)
  nginx.conf          serve a bancada e faz proxy de /api e /socket.io

db/init.sql           schema e seed
```

Três containers saem da mesma imagem `./api`, com entrypoints diferentes:

* **`api`** — a aplicação (`src/main.ts`)
* **`frota`** — simulador de motoristas (`src/sim/fleet.ts`); fala com a API
  pelo mesmo caminho que o aplicativo do motorista usa
* **`coletor`** — agente local de observabilidade (`src/coletor.ts`)

---

# 🔎 Diagnóstico e implementação

A investigação identificou **dois problemas distintos** em pontos diferentes do fluxo.

Eles foram tratados separadamente:

1. **Acoplamento do fluxo de telemetria ao `EventsGateway`**
2. **Gargalo de performance na fila JT808**

A primeira alteração trata da arquitetura do fluxo de telemetria.

A segunda trata da estrutura de dados utilizada pela fila JT808.

---

# Etapa 1 — Telemetria

## Problema identificado

O fluxo de coleta de telemetria estava diretamente acoplado ao `EventsGateway`.

Isso fazia com que o gateway, além de lidar com conexões e eventos em tempo real,

também tivesse conhecimento sobre a responsabilidade de telemetria.

Esse acoplamento dificultava a evolução independente das duas responsabilidades.

Também aumentava a superfície de responsabilidade do gateway e tornava mais difícil testar ou substituir o mecanismo de exportação isoladamente.

---

## Decisão

Foi introduzido um `TelemetrySink` como abstração entre a geração das amostras e o mecanismo responsável pela exportação.

O fluxo passou a seguir a seguinte separação:

```text
EventsGateway
      │
      ▼
TelemetrySink
      │
      ▼
TelemetryExporter
      │
      ▼
FleetLink Collector
```

O `EventsGateway` passa a se preocupar com o fluxo de eventos e com o registro da telemetria, sem precisar conhecer os detalhes de batching, exportação ou transporte.

O `TelemetryExporter` fica responsável pela etapa de exportação.

---

## Benefícios

A alteração permite:

* reduzir o acoplamento entre o gateway e a exportação;
* testar os componentes de forma mais isolada;
* substituir ou evoluir o mecanismo de exportação;
* separar responsabilidades;
* manter o fluxo de eventos independente dos detalhes de telemetria.

A divisão de responsabilidades fica aproximadamente:

| Componente          | Responsabilidade                        |
| ------------------- | --------------------------------------- |
| `EventsGateway`     | Eventos e conexões em tempo real        |
| `TelemetrySink`     | Abstração para recebimento das amostras |
| `TelemetryExporter` | Batching e exportação                   |
| FleetLink           | Codificação e comunicação com o coletor |

---

## Validação da telemetria

A telemetria pode ser acompanhada através de:

```bash
curl -s localhost:3000/telemetry
```

Durante os testes, o endpoint apresentou dados de sessão e do uploader.

Exemplo observado:

```json
{
  "sessao": {
    "amostras": 382,
    "sockets": 35,
    "heapMb": 27
  },
  "uploaderVendor": {
    "active": true,
    "protocol": {
      "supported": "7.4",
      "collector": "7.4"
    },
    "pending": 310,
    "uploaded": 202,
    "failures": 0,
    "flushes": 1
  }
}
```

Os valores são dinâmicos e dependem do momento da execução da simulação.

O coletor também foi acompanhado através de:

```bash
curl -s localhost:9000/stats
```

Exemplo observado:

```json
{
  "lotes": 0,
  "amostras": 0,
  "bytes": 0,
  "protocolo": "7.4",
  "stream": {
    "blocos": 1,
    "bytes": 1473
  }
}
```

---

# Etapa 2 — Gargalo na fila JT808

## Problema identificado

A investigação da integração JT808 encontrou uma operação de ordenação global dentro do método `入队()` da fila de localização.

A implementação original fazia:

```javascript
this.队列.push({
  终端号,
  定位点,
  入队时间: Date.now()
});

this.队列.sort((a, b) =>
  a.定位点.时间.localeCompare(b.定位点.时间)
);
```

Ou seja, **cada nova inserção provocava a ordenação completa da fila**.

Isso faz com que o custo de uma inserção cresça de acordo com o tamanho da fila.

O código fornecido também utilizava, durante a saída, uma combinação de:

```text
filter()
slice()
indexOf()
splice()
```

o que adicionava trabalho adicional sobre a estrutura da fila.

---

## Decisão

A fila foi reestruturada para eliminar a ordenação global a cada inserção.

Foram utilizadas duas estruturas de **min-heap**.

### Heap de tempo de entrada

```text
入队时间堆
```

É utilizado para identificar os itens que já ultrapassaram a janela mínima de 30 segundos.

Como o heap mantém o menor tempo de entrada no topo, não é necessário percorrer toda a fila para descobrir quais itens podem se tornar elegíveis.

### Heap de itens prontos

```text
就绪堆
```

Depois que um item ultrapassa a janela de 30 segundos, ele é transferido para o heap de itens prontos.

Esse heap mantém a prioridade baseada no horário da posição.

Dessa forma, a ordenação necessária passa a acontecer de maneira incremental, sem executar `sort()` sobre toda a coleção.

---

## Nova estratégia

O fluxo passou a ser:

```text
                 ┌─────────────────┐
                 │     入队()      │
                 └────────┬────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │   Map de itens  │
                 └────────┬────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │ 入队时间堆      │
                 └────────┬────────┘
                          │
                   janela de 30s
                          │
                          ▼
                 ┌─────────────────┐
                 │    就绪堆       │
                 │                 │
                 │ prioridade por  │
                 │ tempo da posição│
                 └────────┬────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │   批量出队()    │
                 └─────────────────┘
```

A estrutura principal utiliza um `Map` indexado por uma sequência monotônica.

Isso permite remover itens diretamente pelo identificador, sem precisar procurar o elemento através de `indexOf()`.

---

## Complexidade

### Implementação original

A operação de `入队()` realizava:

```text
push + sort
```

Com isso, cada inserção podia custar:

```text
O(n log n)
```

considerando o tamanho atual da fila.

Esse trabalho era repetido para cada nova entrada.

### Implementação atual

A inserção no min-heap possui custo:

```text
O(log n)
```

A preparação dos itens elegíveis também é incremental.

A remoção de cada item do heap possui custo:

```text
O(log n)
```

Assim, para `k` itens efetivamente removidos:

```text
O(k log n)
```

---

# Janela de 30 segundos

A regra funcional existente foi preservada.

Um item inserido não pode ser consumido imediatamente.

Ele precisa permanecer na fila durante pelo menos:

```text
30 segundos
```

Essa regra continua sendo representada por:

```javascript
const 重排窗口毫秒 = 30000;
```

A diferença é que agora os itens elegíveis são identificados através do heap de tempo de entrada, evitando um `filter()` sobre toda a fila.

---

# Compatibilidade

A interface pública existente da fila foi preservada:

```javascript
入队(终端号, 定位点)
批量出队(数量)
处理报文(原始数据)
取统计()
```

As estatísticas existentes também foram preservadas:

```text
入队
出队
丢弃
重排次数
当前长度
```

A estatística `重排次数` passa a permanecer em `0`, pois a implementação não executa mais uma ordenação global após cada inserção.

---

# 🏗️ Decisões técnicas

## Preservar o protocolo JT808

A correção foi realizada na estrutura de dados da fila.

Não foi necessário alterar o protocolo JT808 nem o parser existente.

O processamento da mensagem `0x0704` continua sendo realizado através do parser já existente.

A decisão foi manter o raio da mudança pequeno e atacar diretamente o gargalo identificado.

---

## Preservar a janela funcional

A janela de 30 segundos foi mantida.

O objetivo da alteração era melhorar a complexidade e o comportamento de performance da fila sem modificar sua regra funcional.

---

## Preservar os nomes originais do vendor

Os nomes em chinês presentes nos arquivos JT808 foram preservados.

Isso foi uma decisão deliberada para evitar uma alteração desnecessária na integração fornecida.

Os nomes representam a implementação original do vendor e foram mantidos para reduzir o risco de introduzir mudanças sem relação com o problema.

---

## Isolar CommonJS no vendor

A API principal utiliza ES Modules, enquanto os arquivos JT808 fornecidos utilizam:

```javascript
require()
module.exports
```

Por isso foi adicionado:

```text
api/vendor/jt808-telematics/package.json
```

com:

```json
{
  "type": "commonjs"
}
```

Dessa maneira, o código vendorizado permanece CommonJS sem alterar a configuração global da aplicação.

---

# 🧪 Validação

Foi criado um teste específico para a fila:

```text
api/vendor/jt808-telematics/test-fila.cjs
```

Execução:

```bash
node api/vendor/jt808-telematics/test-fila.cjs
```

O teste valida:

1. inserção de três itens;
2. bloqueio da saída antes de 30 segundos;
3. liberação após 30 segundos;
4. ordenação cronológica dos itens prontos;
5. remoção dos itens da fila;
6. ausência de ordenação global.

Resultado:

```text
Antes de 30s: 0
Depois de 30s: [
  '26091212000100',
  '26091212000200',
  '26091212000300'
]

Stats finais: {
  '入队': 3,
  '出队': 3,
  '丢弃': 0,
  '重排次数': 0,
  '当前长度': 0
}

✅ TESTE DA FILA PASSOU
```

O teste substitui temporariamente `Date.now()` para controlar o avanço do tempo.

Isso permite validar a janela de 30 segundos de forma determinística sem precisar aguardar 30 segundos durante cada execução.

---

# 📊 Observabilidade

Durante a validação do ambiente foram utilizados os endpoints de telemetria existentes.

Para acompanhar a API em tempo real:

```bash
watch -n 1 'curl -s localhost:3000/telemetry'
```

Para acompanhar o coletor:

```bash
watch -n 1 'curl -s localhost:9000/stats'
```

Esses endpoints permitiram observar:

* quantidade de amostras;
* quantidade de sockets;
* uso de memória;
* itens pendentes;
* itens enviados;
* falhas;
* quantidade de flushes;
* bytes enviados;
* blocos recebidos pelo coletor.

Também foram utilizados os logs do container da API:

```bash
docker compose logs --tail=30 api
```

A inicialização apresentou, entre outros:

```text
[fleetlink] uploader active on protocol 7.4
[EventsGateway] gateway de tempo real pronto
API ouvindo na porta 3000
```

---

# 📁 Principais arquivos alterados

As alterações principais estão concentradas nos seguintes arquivos:

```text
api/src/main.ts
api/src/modules/events/events.gateway.ts
api/src/modules/telemetry/telemetry.exporter.ts
api/src/modules/telemetry/telemetry.sink.ts
api/src/modules/telemetry/telemetry.types.ts

api/vendor/jt808-telematics/批量上报队列.js
api/vendor/jt808-telematics/package.json
api/vendor/jt808-telematics/test-fila.cjs
```

---

# ✅ Conclusão

A investigação identificou dois problemas independentes.

## Telemetria

O fluxo de telemetria foi desacoplado do `EventsGateway` através da introdução de um `TelemetrySink`.

Isso separa a responsabilidade de coleta da responsabilidade de exportação e reduz o acoplamento entre os componentes.

## Fila JT808

A fila JT808 foi reestruturada para eliminar a ordenação global executada a cada `入队()`.

A nova implementação utiliza min-heaps para controlar:

* elegibilidade temporal;
* prioridade dos itens prontos;
* remoção incremental.

Com isso, a inserção deixa de depender de uma ordenação completa da fila.

## Princípio geral

As alterações buscaram manter o comportamento funcional existente e limitar as mudanças aos pontos relacionados aos problemas identificados.

A prioridade foi melhorar a estrutura interna e a separação de responsabilidades sem alterar o protocolo, os contratos públicos ou regras funcionais que não estavam relacionadas ao diagnóstico.
