# D2 Camera

MVP de videochamada por salas usando Node.js, Express, Socket.IO e WebRTC.

## Rodar no Windows

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

## Convites

Dentro da sala, clique em **Copiar link da sala**. O endereço fica no formato:

`https://SEU-ENDERECO/?room=ABC123`

O amigo abre o link, informa o nome, permite câmera/microfone e entra na mesma sala.

## Publicar no Render

O servidor já escuta `process.env.PORT` em `0.0.0.0`, compatível com Render Web Service.
O arquivo `render.yaml` também foi incluído.

- Build: `npm install`
- Start: `npm start`
- Health check: `/health`

## Observação WebRTC

A versão atual usa servidores STUN públicos. Isso funciona em muitas redes, mas não garante conexão entre todos os tipos de NAT/firewall. Para confiabilidade de produção, configure um servidor TURN e adicione as credenciais em `rtcConfig.iceServers` no arquivo `public/app.js`.


## Compartilhamento de tela
Dentro da sala, clique em **Compartilhar tela** e escolha uma aba, uma janela ou a tela inteira. Enquanto a tela estiver sendo compartilhada, ela substitui temporariamente a imagem da câmera para os outros participantes. Ao clicar em **Parar tela** ou encerrar pelo seletor do navegador, a câmera volta automaticamente.
