# Grupos do Balde

Copie para `GRUPOS.md` (o painel faz isso no botão **Grupos**) e edite à mão.
O Balde recarrega sozinho quando você salva. Só os grupos desta tabela são lidos.

- **Link do grupo**: `https://chat.whatsapp.com/XXXX` ou o jid `1203...@g.us`.
- **Ganho total (R$)**: valor total do projeto, formato BR, ex. `6.000,00`.
- **Início / Fim**: `dd/mm/aa` (ano 20aa), opcionais.
- **Tipo**: `cliente` (grupo de um projeto), `despejo` (grupo onde você joga coisas soltas) ou `interno` (projeto sem grupo: deixe o link vazio).
- **Status**: `ativo` ou `arquivado` (vazio = ativo). Projeto arquivado sai do painel e o grupo deixa de ser lido.

Linha com erro vira aviso no log e é ignorada — o resto continua valendo.

| Empresa | Projeto | Link do grupo | Ganho total (R$) | Início | Fim | Tipo | Status |
|---|---|---|---|---|---|---|---|
| Alfa Tech | Website Institucional | 120363011111111111@g.us | 6.000,00 | 01/01/26 | 31/12/26 | cliente | ativo |
| Alfa Tech | Aplicativo Mobile | https://chat.whatsapp.com/ExemploConvite123 | 9.000,00 | 01/03/26 | | cliente | ativo |
| Padaria Modelo | Hospedagem & Suporte | 120363033333333333@g.us | 180,00 | | | cliente | ativo |
| Padaria Modelo | Cardápio novo | | 1.200,00 | | | interno | ativo |
| | | 120363099999999999@g.us | | | | despejo | ativo |
