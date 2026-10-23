# Acord v6.8 — arquitetura de manutenção

## Fontes editáveis

- arquivos `01-core-auth.js`, `02-app-chat.js`, `03-calls-control.js` e `04-features-runtime.js` na raiz: frontend dividido por domínio. O arquivo publicado `bundle-v682.js` é gerado pela concatenação ordenada desses arquivos.
- arquivos CSS `01-foundation.css`, `02-layout.css`, `03-components.css` e `04-calls-themes.css` na raiz: CSS dividido por domínio. O arquivo publicado `app-v682.css` é gerado pela concatenação ordenada desses arquivos.
- `state-indexes.js`: índices de leitura para usuários, amizades, solicitações, servidores, convites e grupos.
- `socket-compat.js`: transporte WebSocket compatível e roteamento de salas.
- `socket-rate-limiter.js`: limites de eventos por socket.
- `auth-utils.js`: utilitários de autenticação/criptografia.

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


## v6.8.2 — Controle compartilhado em um clique
- O Acord Desktop seleciona o monitor principal via `desktopCapturer` e inicia a transmissão automaticamente ao ativar Controle compartilhado.
- Não é mais necessário iniciar `Compartilhar` antes.
- O fluxo de controle usa captura de monitor (não de janela), com atualização de ponteiro em ~60 Hz e prioridade de frame rate.
