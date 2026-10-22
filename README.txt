CONCORDE v4.1

Correção de persistência das mensagens privadas.

Principais mudanças:
- histórico de DM continua salvo no backend;
- capacidade ampliada para até 20.000 mensagens privadas no armazenamento global;
- até 500 mensagens por conversa no histórico carregado;
- cache local por conversa no navegador;
- ao abrir uma DM, o cache local aparece imediatamente e depois é conciliado com o servidor;
- mensagens enviadas recebem ID estável no cliente;
- após reconexão/deploy, as mensagens enviadas pelo próprio usuário podem ser sincronizadas novamente ao backend;
- contador de DMs adicionado ao diagnóstico de persistência;
- conta, servidores, amigos, calls e demais recursos da v4.0 preservados.

Substitua o server.js atual pelo server.js deste ZIP.
