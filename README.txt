ACORD / CONCORDE v4.3 — CLOUDFLARE 100% SEM PC

Esta versão NÃO usa Render, Northflank, alwaysdata nem o seu computador como servidor.

ARQUITETURA
- Frontend: Cloudflare Workers Static Assets
- Backend: Cloudflare Worker
- Tempo real: WebSocket nativo
- Coordenação e persistência: Durable Object com armazenamento SQLite
- URL pública: workers.dev (gratuita)
- GitHub: pode ser conectado diretamente ao Cloudflare Workers Builds

O que foi preservado da v4.2:
- aparência nova da v4.2;
- contas e autenticação;
- perfis;
- servidores;
- canais;
- cargos e permissões;
- amigos e solicitações;
- mensagens privadas;
- grupos privados;
- chat público;
- convites;
- sinalização WebRTC das calls;
- calls privadas e em grupo;
- câmera do celular;
- recursos Concorde+/Essenciais que usam os eventos existentes;
- recuperação local de identidade, servidores e DMs.

O QUE MUDOU
A versão antiga precisava de:
Node.js + Express + Socket.IO + server.js rodando 24h.

A v4.3 usa:
Cloudflare Worker + Durable Object + WebSocket.

Não existe server.js nesta versão porque ele deixou de ser necessário.

GRATUITO
Use o plano Workers Free da Cloudflare.
Durable Objects com SQLite estão disponíveis no plano gratuito.
No plano Free, quando um limite gratuito é atingido, as operações excedentes falham até o reset;
não é necessário transformar o projeto em plano pago para continuar usando dentro dos limites.

Limites atuais relevantes verificados em 22/10/2026:
- Workers Free: 100.000 requisições/dia.
- Durable Objects Free: 100.000 requisições/dia.
- Durable Objects: 13.000 GB-s/dia de duração incluída.
- armazenamento SQLite de Durable Objects: até 5 GB por conta Free.
- WebSocket recebido: até 32 MiB por mensagem.
- Assets estáticos: requisições gratuitas e ilimitadas.

O projeto usa a API de hibernação de WebSockets dos Durable Objects.
Isso permite que o objeto saia da memória quando fica ocioso sem derrubar as conexões,
reduzindo consumo do limite gratuito.

ARQUIVOS PRINCIPAIS
src/index.js
  Backend Cloudflare + Durable Object + eventos do Acord.

public/index.html
  Interface do Acord v4.2.

public/socket.io/socket.io.js
  Camada de compatibilidade que mantém a API usada pelo frontend, mas usa WebSocket nativo.

wrangler.jsonc
  Configuração pronta do Cloudflare Worker/Durable Object/Assets.

package.json
  Configuração para implantação pelo Wrangler/Workers Builds.

DEPLOY_CLOUDFLARE.txt
  Passo a passo para publicar sem usar seu PC como servidor.

MIGRACAO.txt
  Informações para quem já usava a versão Render.

OBSERVAÇÃO SOBRE UPTIME
O Cloudflare não promete formalmente 100% de uptime no plano gratuito.
A diferença para serviços que entram em sleep é que esta arquitetura não depende de uma máquina
sua ligada e não usa um servidor gratuito que precisa ficar acordado. Workers executam sob demanda,
e os WebSockets usam Durable Objects com hibernação.

CALLS
WebRTC continua sendo peer-to-peer.
STUN padrão continua funcionando.
Para redes muito restritivas, um TURN externo ainda é opcional e pode ser configurado por:
TURN_URLS
TURN_USERNAME
TURN_CREDENTIAL
