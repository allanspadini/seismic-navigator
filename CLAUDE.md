# Seismic Navigator

Ferramenta web para processamento de sísmica de refração que roda **inteiramente no navegador do usuário**. Publicada como site estático no GitHub Pages.

## Fluxo do usuário

1. **Carregar** um ou mais arquivos de tiro em SEG-Y ou SEG-2 (cada arquivo normalmente é um tiro).
2. **Conferir a geometria** (posição da fonte e dos geofones) e corrigir quando o header estiver errado ou vazio.
3. **Fazer o picking das primeiras chegadas** traço a traço, tiro a tiro.
4. **Inverter** os tempos de todos os tiros em conjunto para obter o modelo 2D de velocidade da onda P em subsuperfície.
5. **Exportar** picks e modelo.

## Restrições que não mudam

- **Sem backend.** Nada de servidor, API, upload ou banco de dados. Os arquivos do usuário nunca saem da máquina dele; são lidos com `File`/`ArrayBuffer`.
- **Saída estática.** O build precisa funcionar servido de um subcaminho (`https://<usuario>.github.io/seismic-navigator/`), então todos os caminhos de assets são relativos à `base` configurada, nunca absolutos a partir de `/`.
- **Cálculo pesado fora da thread principal.** A inversão roda em Web Worker, com progresso reportado e possibilidade de cancelar; o mesmo vale para qualquer cálculo novo que demore.
- **Persistência só local.** O estado da sessão (picks, geometria editada) pode ir para IndexedDB; o usuário também exporta/importa um arquivo de projeto.

## Stack

- Vite + TypeScript (modo `strict`), sem framework de UI.
- Renderização dos sismogramas em Canvas 2D (trocar para WebGL só se o desempenho exigir).
- Vitest para testes unitários dos parsers e do núcleo numérico; os testes ficam ao lado do código (`*.test.ts`) e rodam em ambiente Node.
- Deploy por GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) publicando `dist/` no GitHub Pages a cada push na `main`. `base: './'` no [vite.config.ts](vite.config.ts) mantém os caminhos relativos.
- Preferir implementação própria a dependências pesadas: parsers e inversão são o núcleo do projeto e devem ser código nosso, legível e testado.

## Comandos

- `npm run dev` — servidor de desenvolvimento em `http://localhost:5173`.
- `npm test` — roda os testes uma vez (`npm run test:watch` para modo contínuo; `npx vitest run src/io/detect.test.ts` para um arquivo).
- `npm run typecheck` — checagem de tipos.
- `npm run build` — checagem de tipos e build de produção em `dist/`.

## Estado atual

O fluxo completo funciona: carregar SEG-Y/SEG-2, editar geometria e topografia, picking manual e automático, curvas tempo–distância, inversão tomográfica em Web Worker, e exportação de picks (CSV), modelo (CSV/PNG) e projeto (JSON).

Ainda não feito:

- Leitura dos arquivos roda na thread principal (os arquivos de refração rasa são pequenos); mover para Worker se aparecerem arquivos grandes.
- Persistência em IndexedDB: hoje a sessão só é guardada pelo arquivo de projeto, que não inclui os traços (os tiros são casados pelo nome do arquivo de dados).
- O parser SEG-Y só foi testado com arquivos sintéticos; o SEG-2 também com arquivos reais da Geometrics.
- Importação de picks de outros programas, filtros de frequência, edição individual de posição de geofone.

## Organização do código

Separar o núcleo (sem DOM, testável em Node) da interface:

- `src/io/` — `detect.ts` (formato pelo conteúdo), `seg2.ts`, `segy.ts`, `read.ts` (ponto de entrada: `ArrayBuffer` → `Shot[]`) e `export.ts` (CSV de picks e modelo, projeto JSON).
- `src/core/` — `types.ts` (`Shot` é o dado lido; `ShotState` é o tiro na sessão, com geometria editável e picks), `topography.ts`, `autopick.ts` (AIC), `synthetic.ts` (levantamento sintético usado como exemplo embutido e nos testes) e `tomo/` (`raytrace.ts` e `invert.ts`).
- `src/workers/inversion.worker.ts` — roda `invert` fora da thread principal; cancelar é encerrar o Worker.
- `src/ui/` — `wiggle.ts` (sismograma e picking), `ttplot.ts` (tempo–distância), `modelview.ts` (modelo), `dom.ts` (utilitários de canvas e tema), `colormap.ts` e `strings.ts` (todos os textos da interface).
- `src/main.ts` — estado da sessão e montagem da interface. Sem framework: os elementos são criados uma vez e `refresh()` redesenha o que depende do estado.

Os dois formatos convergem para uma única representação interna; nada fora de `src/io/` deve saber de qual formato o dado veio.

## Notas de domínio

### SEG-Y

- Header textual de 3200 bytes (EBCDIC ou ASCII — detectar), header binário de 400 bytes, depois traços com header de 240 bytes cada.
- Big-endian por padrão; arquivos little-endian existem na prática, então validar pelo código de formato e detectar a ordem dos bytes.
- Header binário: intervalo de amostragem em µs (bytes 3217–3218), amostras por traço (3221–3222), código de formato (3225–3226).
- Formatos de amostra a suportar: 1 (float IBM de 32 bits — **não** é IEEE, precisa de conversão), 2 (int32), 3 (int16), 5 (float IEEE), 8 (int8).
- Header do traço: offset (37–40), elevações (41–48), escalar de elevação (69–70), escalar de coordenadas (71–72), coordenadas da fonte (73–80) e do receptor (81–88), atraso de gravação (109–110), amostras (115–116) e intervalo (117–118) do traço.
- Os escalares: positivo multiplica, negativo divide, zero equivale a 1.

### SEG-2

- Formato típico de sismógrafos de engenharia (Geometrics, ABEM etc.), em geral little-endian.
- Começa com o bloco descritor do arquivo: identificador `0x3A55` (se lido como `0x553A`, o arquivo é big-endian), número de traços e tabela de ponteiros para os traços.
- Cada traço tem um bloco descritor (identificador `0x4422`) com tamanho do bloco, tamanho dos dados, número de amostras e código de formato: 1 (int16), 2 (int32), 3 (ponto flutuante de 20 bits), 4 (float IEEE 32), 5 (float IEEE 64).
- Metadados são strings `CHAVE valor` nos blocos descritores. As que importam: `SAMPLE_INTERVAL`, `DELAY`, `RECEIVER_LOCATION`, `SOURCE_LOCATION`, `DESCALING_FACTOR`, `STACK`.

### Geometria

Em dados de refração rasa os headers de geometria frequentemente estão vazios, incompletos ou errados. A interface precisa permitir definir e editar posição de fonte, espaçamento e posição dos geofones e elevações, e a geometria editada tem prioridade sobre a do arquivo.

### Picking

- Um pick é um tempo (em segundos, já considerando o atraso de gravação) associado a um par fonte–receptor, ou ausente.
- Recursos de visualização que o picking precisa: ganho/normalização por traço, clip, zoom no tempo, wiggle e densidade variável.
- Picking automático (AIC por traço) é auxílio, sempre editável manualmente; em dados reais erra alguns traços.
- O wiggle segue o estilo do [graphSEG2](https://github.com/tonianr/graphSEG2): traços na posição dos geofones, tempo para baixo, normalização por traço com ganho e lóbulos positivos preenchidos.
- Curvas tempo–distância de todos os tiros juntas servem de controle de qualidade, incluindo a checagem de reciprocidade entre tiros.

### Inversão

Como está implementada (`src/core/tomo/`):

- **Malha**: nós regulares de lado `h`; a vagarosidade é definida nos nós. Nós acima da topografia são "ar" e ficam fora do grafo.
- **Modelagem direta**: método do caminho mínimo (Dijkstra) sobre os nós, cada um ligado a 32 vizinhos (deslocamentos coprimos até 3 células). O custo da aresta é comprimento × média da vagarosidade das pontas. Fontes e geofones ficam na posição exata, ligados aos nós próximos. Limitação conhecida: interfaces bruscas são suavizadas em até 1,5 célula.
- **Inversão**: o parâmetro é ln(vagarosidade). Cada iteração traça os raios e resolve por CGLS um sistema regularizado por suavidade (primeiras diferenças, peso vertical menor que o horizontal) que relaxa a cada iteração. Pesos de Huber reduzem o efeito de picks discrepantes. O modelo devolvido é o de menor resíduo absoluto médio.
- **Modelo inicial**: gradiente linear de velocidade com a profundidade abaixo da superfície; `suggestParams` estima os valores a partir dos picks.
- Sempre mostrar ao usuário o desajuste (RMS e resíduo mediano, em ms), os tempos observados contra os calculados e a cobertura de raios — a parte do modelo abaixo do raio mais profundo é extrapolação e aparece esmaecida.

## Convenções

- Unidades internas em SI: metros, segundos, m/s. Converter na entrada (µs dos headers) e na exibição (ms na tela).
- Código e identificadores em inglês; textos da interface em português, centralizados para permitir tradução depois.
- Tema claro por padrão, com botão para alternar; a escolha fica em `localStorage`. As cores vêm das variáveis CSS em `:root` e `:root[data-theme='dark']`, e os canvas as leem via `readTheme()` — não fixar cores no código de desenho.
- [docs/banner.svg](docs/banner.svg) é usado no README e também na página inicial (importado como texto em `src/main.ts`, com as cores trocadas pelas variáveis do tema). Ao mudar uma cor no SVG, atualize `BANNER_COLORS`.
- Código numérico usa `Float32Array`/`Float64Array`, não arrays genéricos.
- Todo parser e toda rotina numérica tem teste. Os parsers são testados com arquivos sintéticos pequenos montados no próprio teste; ainda não há arquivos reais no repositório.
- A modelagem direta é validada contra casos com solução analítica (meio homogêneo, duas camadas planas).
