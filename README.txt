CONCORDE v4.0

Atualização focada na experiência real das calls.

PRINCIPAIS MELHORIAS
- nova tela de pré-call para conferir câmera e microfone antes de entrar;
- entrar mutado e/ou com câmera desligada;
- layouts Grade, Foco e Apresentação;
- fixar/desafixar participante;
- qualidade de conexão individual por participante;
- ping, jitter, perda de pacotes e rota ICE;
- indicador visível se TURN está realmente configurado;
- detecção visual de quem está falando;
- aviso quando você fala com o microfone mutado;
- overlay de reconexão sem tirar o usuário da call;
- botão Corrigir minha call preservado e reforçado;
- call em tela cheia no celular;
- mensagens de erro mais claras para câmera, microfone e compartilhamento;
- preferências de call continuam salvas;
- conta, servidores, amigos e recuperação preservados.

TURN
O backend já aceita TURN por:
TURN_URLS
TURN_USERNAME
TURN_CREDENTIAL

A interface agora mostra se o TURN está realmente configurado.

POSTGRESQL
Não foi ativado automaticamente nesta versão porque exige banco/credenciais e dependência
de infraestrutura. A persistência atual foi preservada para evitar quebrar contas e servidores.
