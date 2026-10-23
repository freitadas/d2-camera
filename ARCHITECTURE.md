# Acord v6.8 — arquitetura de manutenção

## Fontes editáveis

- `src/client/`: frontend dividido por domínio. O arquivo publicado `bundle-v68.js` é gerado pela concatenação ordenada desses arquivos.
- `src/styles/`: CSS dividido por domínio. O arquivo publicado `app-v68.css` é gerado pela concatenação ordenada desses arquivos.
- `src/worker/state-indexes.js`: índices de leitura para usuários, amizades, solicitações, servidores, convites e grupos.
- `src/worker/socket-compat.js`: transporte WebSocket compatível e roteamento de salas.
- `src/worker/socket-rate-limiter.js`: limites de eventos por socket.
- `src/worker/auth-utils.js`: utilitários de autenticação/criptografia.

## Build e testes

- `npm run build:assets`: regenera os assets publicados a partir das fontes modulares.
- `npm run check:generated`: falha se os assets publicados estiverem diferentes das fontes.
- `npm test`: executa verificação de assets, smoke, segurança e regressões de escalabilidade.

## Escalabilidade v6.8

A v6.8 mantém o Durable Object coordenador único para preservar compatibilidade dos dados, mas remove vários custos O(n) dos caminhos quentes:

- índice de sockets por usuário;
- índice de sockets por sala;
- índices de username, amizade, solicitações, servidor, convite e grupo;
- broadcasts direcionados aos membros em vez de varrer todos os sockets;
- persistência coalescida em janela curta para reduzir write amplification;
- índices SQL adicionais para DM, mídia e limpeza de rate limit;
- limite de tamanho de pacote WebSocket e rate limiting por tipo de evento;
- limpeza periódica de sessões/calls/QR/controle compartilhado expirados.

O próximo salto de escala, quando necessário, é particionar o coordenador em Durable Objects por domínio/servidor sem alterar o protocolo do cliente.
