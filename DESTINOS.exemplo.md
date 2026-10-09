# Destinos de Distribuição

| Nome | Tipo | Alvo |
|---|---|---|
| Automação n8n | webhook | https://n8n.meuservidor.com/webhook/distribuicao |
| Agente Local | agente | agy-agent |
| Script de Deploy | comando | /usr/local/bin/meuscript.sh |

Copie para `balde/DESTINOS.md` e configure somente destinos autorizados.
O arquivo real contém configuração privada: mantenha-o fora do Git
(`balde/DESTINOS.md` no ignore do repositório ou no exclude local).

A fila aceita `destino: "Nome"`, `{nome: "Nome"}` ou `{tipo, alvo}`;
o destino deve corresponder a uma única linha desta tabela. O arquivo é relido
para cada entrada. Webhooks recebem `{tarefa, mensagens_fonte}`. Agentes geram
`dados/despacho/<tarefaId>.md`; comandos executam o Alvo como executável, sem shell,
com o caminho absoluto desse briefing como único argumento. Alvo não aceita
argumentos embutidos. Nenhuma mensagem é enviada pelo WhatsApp.

`BALDE_DADOS` e `BALDE_DESTINOS` substituem os caminhos padrão.
A fila JSONL é append-only: cada entrada precisa terminar com quebra de linha.
O offset é medido em bytes. Sucessos e falhas são registrados e não são repetidos
no reinício normal; para tentar uma falha novamente, acrescente outra entrada.
Não há garantia exactly-once caso o processo morra entre o efeito externo e a
gravação do resultado; webhooks/comandos devem ser idempotentes pelo ID da tarefa.
Execute uma única instância do distribuidor por diretório de dados.
