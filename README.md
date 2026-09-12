# Desafio prático — Engenheiro(a) de Software Sênior, Backend

> **Status:** Implementação concluída e validada

Bem-vindo. Este repositório é um recorte controlado da nossa plataforma de mobilidade: a API de tempo real, o banco de corridas e uma bancada visual que simula motoristas em operação.

O trabalho começa com um chamado aberto pelo suporte.

---

## 📑 Sumário

* [O chamado](#o-chamado)
* [Subindo o ambiente](#subindo-o-ambiente)
* [O que esperamos da entrega](#o-que-esperamos-da-entrega)
* [Mapa do repositório](#mapa-do-repositório)
* [Diagnóstico e implementação](#diagnóstico-e-implementação)

  * [Etapa 1 — Telemetria](#etapa-1--telemetria)
  * [Etapa 2 — Gargalo na fila JT808](#etapa-2--gargalo-na-fila-jt808)
  * [Etapa 3 — Broadcast global de posições](#etapa-3--broadcast-global-de-posições)
* [Decisões técnicas](#decisões-técnicas)
* [Validação](#validação)
* [Observabilidade](#observabilidade)
* [Limitações e próximos passos](#limitações-e-próximos-passos)
* [Conclusão](#conclusão)

---

# 📋 Enunciado original

## O chamado

> **Chamado #4471 — Suporte / Financeiro — prioridade alta**
>
> Motoristas de Muzambinho vêm reclamando que o aplicativo consome o pacote de dados deles.
>
> O financeiro sinalizou que a linha de saída de dados do provedor de infraestrutura subiu.
>
> Precisamos entender o que está acontecendo e o que fazer a respeito.

Ninguém sabe a causa. Faz parte do desafio descobrir.

---

# Subindo o ambiente

Requisitos: Docker e Docker Compose.

```bash
docker compose up -d --build
```

O ambiente está pronto quando a API responder:

```bash
curl -s localhost:3000/health
```

Nos primeiros segundos a API pode reiniciar uma ou duas vezes com `ECONNREFUSED` no MySQL — isso é esperado, pois o `restart: unless-stopped` cuida da inicialização.

O seed carrega cerca de 100 mil corridas.

### Portas utilizadas

* **Bancada visual:** `http://localhost:8080`
* **API:** `http://localhost:3000`
* **Coletor de telemetria:** `http://localhost:9000`

  * `/stats`
  * `/handshake`
* **MySQL:** `localhost:3306`
* **Redis:** `localhost:6379`

Na bancada, o botão **Iniciar teste** conecta os aparelhos e a frota de fundo.

Cada aparelho roda uma corrida completa de aproximadamente 40 segundos; a frota permanece circulando pela malha emitindo atualizações de posição.

É importante deixar o teste chegar ao final pelo menos uma vez antes de tirar conclusões.

Sem apertar o botão, **nenhum motorista fica online** — a frota somente conecta quando a simulação é ativada.

Para derrubar tudo, inclusive os dados:

```bash
docker compose down -v
```

---

# O que esperamos da entrega

Um repositório Git com o trabalho e um `README.md` na raiz descrevendo:

* o diagnóstico;
* as decisões tomadas;
* as alterações realizadas;
* como as alterações foram validadas.

## Sobre uso de IA

Pode usar. Não vamos perguntar e não vamos penalizar.

O que avaliamos é a entrega e a capacidade de sustentá-la: na etapa seguinte você vai conversar com a gente sobre as decisões deste repositório.

---

# Mapa do repositório

```text
docker-compose.yml    seis serviços: mysql, redis, api, coletor, frota, web

api/                   API Node.js — tempo real, corridas, precificação, telemetria
  src/                 código da aplicação
  vendor/              integrações de terceiros com patch local

web/                   bancada visual (HTML/CSS/JS sem build)
  nginx.conf           serve a bancada e faz proxy de /api e /socket.io

db/init.sql            schema e seed
```

Três containers saem da mesma imagem `./api`, com entrypoints diferentes:

* **`api`** — aplicação principal (`src/main.ts`);
* **`frota`** — simulador de motoristas (`src/sim/fleet.ts`);
* **`coletor`** — agente local de observabilidade (`src/coletor.ts`).

---

# 🔎 Diagnóstico e implementação

Durante a investigação foram identificados **três pontos principais no fluxo da aplicação**, além de uma correção de segurança de concorrência relacionada às sessões dos motoristas.

Os problemas foram tratados separadamente:

1. **Acoplamento do fluxo de telemetria ao `EventsGateway`;**
2. **Gargalo de performance na fila JT808;**
3. **Broadcast global das posições dos motoristas.**

Também foi corrigido um problema de concorrência em desconexões de sockets antigos, que poderia fazer uma sessão nova de um motorista ser removida por um `disconnect` atrasado.

---

# Etapa 1 — Telemetria

## Problema identificado

O fluxo de coleta de telemetria estava diretamente acoplado ao `EventsGateway`.

Isso fazia com que o gateway, além de lidar com conexões e eventos em tempo real, também tivesse conhecimento sobre a responsabilidade de telemetria.

Esse acoplamento dificultava a evolução independente das responsabilidades e aumentava a superfície de responsabilidade do gateway.

---

## Decisão

Foi introduzido um `TelemetrySink` como abstração entre a geração das amostras e o mecanismo responsável pela exportação.

O fluxo passou a seguir:

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

O `EventsGateway` registra a amostra de telemetria, mas não precisa conhecer os detalhes de batching, compressão ou transporte.

O `TelemetryExporter` fica responsável pela exportação.

---

## Benefícios

A separação permite:

* reduzir o acoplamento entre gateway e exportação;
* testar os componentes de forma isolada;
* substituir ou evoluir o mecanismo de exportação;
* manter o fluxo de eventos independente da implementação de telemetria.

| Componente          | Responsabilidade                        |
| ------------------- | --------------------------------------- |
| `EventsGateway`     | Conexões e eventos em tempo real        |
| `TelemetrySink`     | Abstração para recebimento das amostras |
| `TelemetryExporter` | Batching e exportação                   |
| FleetLink           | Codificação e comunicação com o coletor |

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

Ou seja:

> **cada nova inserção provocava a ordenação completa da fila.**

Com o crescimento da fila, o custo de cada inserção também crescia.

Durante a saída, a implementação original também utilizava operações como:

```text
filter()
slice()
indexOf()
splice()
```

adicionando trabalho adicional sobre a estrutura.

---

## Decisão

A fila foi reestruturada utilizando duas estruturas de **min-heap**.

### Heap de tempo de entrada

```text
入队时间堆
```

É utilizado para identificar os itens que já ultrapassaram a janela mínima de 30 segundos.

Como o menor tempo de entrada fica no topo, não é necessário percorrer toda a fila para encontrar os itens elegíveis.

### Heap de itens prontos

```text
就绪堆
```

Depois que um item ultrapassa a janela de 30 segundos, ele é transferido para o heap de itens prontos.

Esse heap mantém a prioridade pelo horário da posição.

---

## Nova estratégia

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
                 │  入队时间堆     │
                 └────────┬────────┘
                          │
                    janela de 30s
                          │
                          ▼
                 ┌─────────────────┐
                 │     就绪堆      │
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

Isso permite localizar e remover itens diretamente, sem precisar executar `indexOf()` sobre a coleção.

---

## Complexidade

### Implementação original

A operação de entrada realizava:

```text
push + sort
```

Com isso, uma inserção podia custar:

```text
O(n log n)
```

Esse trabalho era repetido para cada nova entrada.

### Implementação atual

A inserção no min-heap possui custo:

```text
O(log n)
```

A remoção de cada item do heap também possui custo:

```text
O(log n)
```

Assim, para `k` itens efetivamente removidos:

```text
O(k log n)
```

A alteração elimina a necessidade de reordenar toda a coleção a cada inserção.

---

# Janela de 30 segundos

A regra funcional existente foi preservada.

Um item inserido não pode ser consumido imediatamente.

Ele precisa permanecer na fila durante pelo menos:

```text
30 segundos
```

Essa regra continua representada por:

```javascript
const 重排窗口毫秒 = 30000;
```

A diferença é que os itens elegíveis agora são identificados através do heap de tempo de entrada, evitando uma varredura completa da fila.

---

# Etapa 3 — Broadcast global de posições

## Problema identificado

Durante a investigação do fluxo de WebSocket foi identificado um problema diferente do JT808.

O evento de posições dos motoristas estava sendo emitido através de um broadcast global:

```javascript
this.server.emit(event, data);
```

Esse tipo de emissão envia o evento para **todos os sockets conectados ao servidor**, independentemente da cidade em que estejam.

Isso é particularmente problemático em uma plataforma de mobilidade porque os clientes normalmente possuem um escopo geográfico.

Por exemplo:

```text
Motorista da cidade 1
       │
       ▼
atualiza posição
       │
       ▼
broadcast global
       │
       ├── clientes da cidade 1
       ├── clientes da cidade 2
       └── clientes da cidade 3
```

Um cliente interessado somente na cidade 1 poderia receber atualizações de motoristas da cidade 2 ou 3.

Além do desperdício de dados, isso aumenta desnecessariamente o tráfego de saída.

---

# Correção do broadcast

Os sockets já são associados às salas das respectivas cidades:

```text
city:1
city:2
city:3
```

A emissão do evento de localização passou a utilizar a sala correspondente:

```typescript
const sala = Sala.cidade(String(cityId));

this.server
  .to(sala)
  .emit(event, data);
```

O fluxo passou a ser:

```text
motorista
    │
    ▼
driver.location
    │
    ▼
atualiza posição
    │
    ▼
identifica cityId
    │
    ▼
city:{cityId}
    │
    ├── clientes interessados na cidade
    │
    └── nenhum cliente de outras cidades
```

A implementação específica de `driver.positions` utiliza:

```typescript
public async emitDriverLocations(cityId: number): Promise<void> {
  const drivers =
    await this.driverService.listarOnline(cityId);

  this.emitCityEvent(
    cityId,
    'driver.positions',
    drivers,
  );
}
```

Portanto, o evento de localização deixou de utilizar o broadcast global.

---

# Redução adicional de broadcasts

Depois de eliminar o broadcast global, foi identificado um segundo problema no mesmo fluxo.

Mesmo limitado à cidade correta, fazer:

```text
cada ping
    ↓
listar todos os motoristas online
    ↓
emitir snapshot completo
    ↓
todos os clientes da cidade
```

ainda pode gerar trabalho desnecessário.

Por isso, o gateway foi alterado para desacoplar a frequência de ingestão da frequência de atualização do mapa.

---

## Antes

O fluxo era aproximadamente:

```text
driver.location
      │
      ▼
atualiza Redis
      │
      ▼
listarOnline(cityId)
      │
      ▼
broadcast
```

Cada atualização podia provocar um novo snapshot.

---

## Depois

O fluxo passou a ser:

```text
driver.location
      │
      ▼
atualiza posição
      │
      ▼
marca cityId como pendente
      │
      ▼
┌──────────────────────┐
│ broadcast loop       │
│ a cada 200 ms        │
└──────────┬───────────┘
           │
           ▼
emitir snapshot da cidade
```

As cidades pendentes são armazenadas em um `Set`:

```typescript
const cidadesPendentes = new Set<number>();
```

Isso permite que vários pings da mesma cidade sejam agrupados.

Por exemplo:

```text
100 pings
   │
   ├── cidade 1
   ├── cidade 1
   ├── cidade 1
   ├── cidade 2
   ├── cidade 1
   └── ...
        │
        ▼
Set
{ 1, 2 }
        │
        ▼
2 broadcasts
```

Assim, a quantidade de atualizações recebidas pelos motoristas não precisa ser igual à quantidade de snapshots enviados aos clientes.

O intervalo utilizado atualmente é:

```typescript
const BROADCAST_INTERVAL_MS = 200;
```

Isso representa uma frequência máxima de aproximadamente 5 ciclos de broadcast por segundo por cidade com atualizações pendentes.

---

# O que não foi alterado

Não foi implementado o envio de apenas o delta da posição.

Uma alternativa futura seria transmitir:

```json
{
  "driverId": 123,
  "latitude": -21.37,
  "longitude": -46.52,
  "heading": 90,
  "speed": 34
}
```

em vez de um snapshot completo:

```json
[
  { "motorista": 1 },
  { "motorista": 2 },
  { "motorista": 3 }
]
```

Essa abordagem poderia reduzir ainda mais o tamanho dos payloads.

Entretanto, ela exigiria alterações no contrato entre servidor e clientes.

Por isso, a implementação atual priorizou primeiro as correções de maior impacto e menor risco:

1. eliminar o broadcast global;
2. restringir a emissão à cidade;
3. agregar broadcasts em intervalos curtos.

---

# Concorrência na desconexão

Durante a validação do fluxo de WebSocket também foi observado um cenário de reconexão rápida.

Um motorista poderia:

```text
Socket A conecta
       │
       ▼
Socket A é substituído por Socket B
       │
       ▼
Socket A recebe disconnect atrasado
```

Se o `disconnect` do Socket A simplesmente removesse o motorista pelo `driverId`, poderia apagar incorretamente a sessão criada pelo Socket B.

Por isso, a desconexão passou a ser condicionada ao socket que realmente é dono da sessão atual.

O serviço utiliza:

```typescript
desconectar(
  driverId,
  socketClientId,
)
```

e o repositório somente remove a posição quando o socket informado ainda corresponde à sessão armazenada.

Assim:

```text
Socket antigo
    │
    ▼
disconnect
    │
    ▼
socket não é mais o dono
    │
    ▼
NÃO remove a sessão atual
```

Esse comportamento foi importante durante os testes, nos quais apareceram sequências de:

```text
motorista X desconectado
motorista X conectado
```

sem que a sessão nova fosse indevidamente apagada.

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

A estatística:

```text
重排次数
```

permanece em `0`, pois a nova implementação não executa mais uma ordenação global após cada inserção.

---

# 🏗️ Decisões técnicas

## Preservar o protocolo JT808

A correção da fila foi realizada na estrutura de dados.

Não foi necessário alterar o protocolo JT808 nem o parser existente.

O processamento da mensagem `0x0704` continua sendo realizado através do parser fornecido.

A decisão foi manter o raio da mudança pequeno e atacar diretamente o gargalo identificado.

---

## Preservar a janela funcional

A janela de 30 segundos foi mantida.

O objetivo da alteração era melhorar a complexidade e o comportamento de performance da fila sem modificar sua regra funcional.

---

## Restringir eventos pelo domínio

Para eventos relacionados à localização, o escopo da emissão passou a ser definido pela cidade.

Isso evita que o servidor envie dados de localização para clientes que não possuem interesse naquele conjunto de motoristas.

A regra utilizada é:

```text
driver
  ↓
cityId
  ↓
city:{cityId}
  ↓
clientes da cidade
```

---

## Agregar atualizações sem alterar a ingestão

Os pings continuam sendo processados normalmente.

A alteração ocorre somente na etapa de distribuição:

```text
INGESTÃO
driver.location
     ↓
atualiza posição

DISTRIBUIÇÃO
     ↓
marca cidade
     ↓
broadcast loop
     ↓
snapshot
```

Dessa forma, não é necessário reduzir a frequência com que o servidor recebe as posições dos motoristas para reduzir a frequência de atualização do mapa.

---

## Preservar os nomes originais do vendor

Os nomes em chinês presentes nos arquivos JT808 foram preservados.

Isso foi uma decisão deliberada para evitar alterações desnecessárias na integração fornecida.

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

## Teste da fila JT808

Foi criado um teste específico:

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

Resultado observado:

```text
Antes de 30s: 0

Depois de 30s:
[
  '26091212000100',
  '26091212000200',
  '26091212000300'
]

Stats finais:
{
  '入队': 3,
  '出队': 3,
  '丢弃': 0,
  '重排次数': 0,
  '当前长度': 0
}

✅ TESTE DA FILA PASSOU
```

O teste substitui temporariamente `Date.now()` para controlar o avanço do tempo.

Isso permite validar a janela de 30 segundos de forma determinística.

---

# Validação do WebSocket e Redis

Durante o teste da bancada, foram acompanhadas as estruturas utilizadas pelo fluxo de localização.

Com motoristas conectados, foram observados, por exemplo:

```bash
docker compose exec redis redis-cli \
  --scan --pattern 'driver:pos:*' | wc -l
```

e:

```bash
docker compose exec redis redis-cli \
  --scan --pattern 'driver:socket:*' | wc -l
```

Durante a execução do teste foram observados:

```text
driver:pos:*      26
driver:socket:*   26
```

Também foram verificadas as estruturas por cidade:

```bash
docker compose exec redis redis-cli ZCARD driver:city:1
docker compose exec redis redis-cli ZCARD driver:city:2
docker compose exec redis redis-cli ZCARD driver:city:3
```

Durante a execução:

```text
city 1: 19
city 2: 4
city 3: 3
```

Total:

```text
19 + 4 + 3 = 26
```

Isso permitiu confirmar que as posições estavam sendo indexadas nas cidades correspondentes.

Ao final da execução da bancada, as estruturas chegaram a:

```text
driver:pos:* = 0
```

confirmando a remoção das posições quando os motoristas foram desconectados.

---

# Validação do fluxo de desconexão

Os logs da API foram acompanhados durante a simulação:

```bash
docker compose logs --since=30s api
```

Foram observadas sequências de reconexão de alguns motoristas, por exemplo:

```text
motorista 8 desconectado
motorista 8 conectado
```

e:

```text
motorista 51 desconectado
motorista 51 conectado
```

Também foi observada a desconexão da frota ao final do teste.

O comportamento confirmou a necessidade de associar a remoção da sessão ao `socketClientId`, evitando que um `disconnect` atrasado de um socket antigo remova uma sessão mais nova.

---

# Validação do broadcast por cidade

Foi feita uma busca no código para localizar emissões globais:

```bash
grep -RniE \
  "server\.emit|this\.server\.emit|io\.emit|this\.io\.emit|emitDriverLocations" \
  api/src/modules/events
```

O resultado mostrou que o evento de localização passa por:

```text
EventsGateway
    ↓
emitDriverLocations()
    ↓
emitCityEvent()
    ↓
server.to(cityRoom).emit()
```

O único `this.server.emit()` encontrado está no método legado:

```typescript
emitEvent(event, data)
```

Esse método é mantido por compatibilidade, mas **não é utilizado pelo fluxo `driver.positions`**.

Também foi feita uma busca direta:

```bash
grep -Rni "driver.positions" api/src
```

Resultado:

```text
api/src/modules/events/events.emitter.ts
```

A emissão está centralizada em:

```typescript
public async emitDriverLocations(cityId: number): Promise<void> {
  const drivers = await this.driverService.listarOnline(cityId);

  this.emitCityEvent(
    cityId,
    'driver.positions',
    drivers,
  );
}
```

E `emitCityEvent()` utiliza:

```typescript
this.server
  .to(sala)
  .emit(event, data);
```

Portanto, não existe atualmente outro caminho identificado no código-fonte para o evento `driver.positions` realizar broadcast global.

---

# 📊 Observabilidade

Durante a validação do ambiente foram utilizados os endpoints existentes.

Para acompanhar a API:

```bash
watch -n 1 'curl -s localhost:3000/telemetry'
```

Para acompanhar o coletor:

```bash
watch -n 1 'curl -s localhost:9000/stats'
```

Também foram utilizados:

```bash
docker compose logs --tail=30 api
```

e:

```bash
docker compose logs -f api
```

---

## Exemplo de telemetria observada

Durante os testes foram observados valores como:

```json
{
  "sessao": {
    "amostras": 1286,
    "sockets": 69,
    "heapMb": 27
  },
  "exportacao": {
    "capturadas": 0,
    "enviadas": 0,
    "lotes": 0,
    "falhas": 0
  },
  "uploaderVendor": {
    "active": true,
    "protocol": {
      "supported": "7.4",
      "collector": "7.4"
    },
    "pending": 0,
    "uploaded": 1017,
    "failures": 0,
    "flushes": 2
  }
}
```

Os valores são dinâmicos e dependem do momento da execução.

Um ponto importante observado durante a validação foi:

```text
failures: 0
```

indicando ausência de falhas de exportação no teste realizado.

---

# 📁 Principais arquivos alterados

As alterações principais estão concentradas nos seguintes arquivos:

```text
api/src/main.ts

api/src/modules/events/events.gateway.ts
api/src/modules/events/events.emitter.ts
api/src/modules/events/events.rooms.ts

api/src/modules/driver/driver.service.ts
api/src/modules/driver/driver.repository.ts
api/src/modules/driver/driver.types.ts

api/src/modules/telemetry/telemetry.exporter.ts
api/src/modules/telemetry/telemetry.sink.ts
api/src/modules/telemetry/telemetry.types.ts

api/vendor/jt808-telematics/批量上报队列.js
api/vendor/jt808-telematics/package.json
api/vendor/jt808-telematics/test-fila.cjs
```

---

# Limitações e próximos passos

A implementação atual resolve os principais problemas identificados no fluxo sem alterar contratos desnecessariamente.

Ainda existem otimizações possíveis.

## 1. Enviar apenas delta de posição

Atualmente o servidor ainda envia um snapshot dos motoristas online da cidade:

```text
driver.position
      ↓
listarOnline(cityId)
      ↓
snapshot completo
      ↓
clientes da cidade
```

Uma evolução seria enviar somente a posição alterada:

```json
{
  "driverId": 123,
  "latitude": -21.37,
  "longitude": -46.52,
  "heading": 90,
  "speed": 34
}
```

Isso reduziria ainda mais o tamanho dos payloads.

Porém, essa alteração exigiria uma mudança no contrato esperado pelo cliente.

---

## 2. Ajustar dinamicamente o intervalo de broadcast

Atualmente o intervalo é fixo:

```text
200 ms
```

Uma evolução poderia considerar:

* quantidade de motoristas;
* quantidade de clientes;
* volume de atualizações;
* carga do servidor.

Assim, cidades com pouca atividade poderiam receber menos broadcasts enquanto cidades com alta atividade poderiam utilizar uma frequência maior dentro de limites definidos.

---

## 3. Escalar o estado de pendências

A implementação atual mantém:

```typescript
const cidadesPendentes = new Set<number>();
```

em memória do processo.

Em um ambiente com múltiplas instâncias da API, seria necessário avaliar uma estratégia distribuída para que as instâncias compartilhem corretamente o estado de atualização.

---

# ✅ Conclusão

A investigação identificou problemas em diferentes partes do sistema e cada um foi tratado no seu próprio nível.

## Telemetria

O fluxo de telemetria foi desacoplado do `EventsGateway` através da introdução de um `TelemetrySink`.

Isso separa a responsabilidade de coleta da responsabilidade de exportação.

---

## Fila JT808

A fila JT808 foi reestruturada para eliminar a ordenação global executada a cada `入队()`.

A nova implementação utiliza min-heaps para controlar:

* elegibilidade temporal;
* prioridade dos itens prontos;
* remoção incremental.

Com isso, a inserção deixa de depender de uma ordenação completa da fila.

---

## Broadcast de posições

O evento `driver.positions` deixou de utilizar broadcast global.

Antes:

```text
posição
   ↓
server.emit()
   ↓
TODOS os sockets
```

Agora:

```text
posição
   ↓
cityId
   ↓
city:{cityId}
   ↓
somente clientes da cidade
```

Além disso, as atualizações foram agregadas em uma janela de 200 ms, evitando que cada ping gere necessariamente um novo snapshot.

---

## Concorrência de sockets

A desconexão também passou a validar o `socketClientId`.

Isso evita que um `disconnect` atrasado de uma conexão antiga remova uma sessão mais nova do mesmo motorista.

---

## Princípio geral

As alterações buscaram manter o comportamento funcional existente e limitar as mudanças aos pontos relacionados aos problemas identificados.

A estratégia foi:

```text
IDENTIFICAR O GARGALO
        ↓
REDUZIR O ESCOPO DA MUDANÇA
        ↓
PRESERVAR CONTRATOS
        ↓
VALIDAR COM TESTES E OBSERVABILIDADE
```

O resultado é uma implementação que reduz trabalho desnecessário no backend, evita distribuição global de eventos de localização, melhora a estrutura da fila JT808 e mantém as responsabilidades dos componentes mais bem separadas.
