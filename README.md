# e-cord 1.1

Versão com correção de estabilidade do áudio.

Principais ajustes:
- mantém áudio e vídeo remotos no mesmo card sem substituir a faixa de áudio;
- recria o microfone automaticamente se o navegador ou o sistema encerrar a faixa;
- tenta recuperar conexões WebRTC instáveis com ICE restart;
- reentra na sala após reconexão do Socket.IO;
- mantém compartilhamento de tela;
- identidade visual e título e-cord.

## Render
Build Command: `npm install`
Start Command: `npm start`

Envie os arquivos deste pacote para a raiz do mesmo repositório no GitHub e faça um novo deploy no Render.
