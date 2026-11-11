# AgroSense Dashboard — Grupo 1

Dashboard de monitoramento da infraestrutura do Projeto Integrador FATEC 2026. A interface possui menu lateral responsivo (menu hambúrguer em telas menores) e páginas individuais para MariaDB, MongoDB, Redis, MinIO e MQTT.

## O que cada tela apresenta

- **Visão geral:** disponibilidade dos cinco serviços e indicadores consolidados.
- **MariaDB:** database configurado, inventário de tabelas/views e estimativa de linhas via `information_schema.TABLES` (o valor `TABLE_ROWS` pode ser aproximado, especialmente em InnoDB).
- **MongoDB:** databases não sistêmicos, coleções e contagem estimada por `estimatedDocumentCount()`.
- **Redis:** PING, versão, uptime, memória usada, `DBSIZE` e amostra de até 25 chaves/tipos via SCAN.
- **MinIO:** buckets e amostra limitada de até cinco objetos por bucket (máximo de dez buckets).
- **MQTT:** estado do broker, tópicos observados e mensagens recentes em tempo real.

As consultas são feitas pelo backend. Senhas e URIs não são enviadas ao navegador.

## Requisitos

- Docker Desktop com Docker Compose, ou Docker Engine/Compose.
- Arquivo `.env` na raiz do projeto, preenchido com as credenciais autorizadas do Grupo 1.

## Executar localmente

Na pasta do projeto:

```bash
docker compose up -d --build
```

Acesse `http://localhost:8081`.

Para acompanhar os logs:

```bash
docker compose logs -f dashboard-grupo1
```

Para parar:

```bash
docker compose down
```

## Portainer

1. Acesse o Portainer da turma e entre com o usuário do Grupo 1.
2. Abra **Stacks > Add stack**.
3. Para deploy por Git, use um repositório privado e NÃO versione `.env`. Configure as variáveis na Stack e remova `env_file: - .env` do compose, ou use deploy por arquivos no servidor mantendo `.env` junto do compose.
4. Use a porta `8081` (ou altere `HOST_PORT` para outra porta reservada de `8081` a `8090`).
5. Faça o deploy e acesse `http://IP_DO_SERVIDOR:8081`.

## Variáveis de ambiente

O arquivo `.env` local contém as credenciais. Use `.env.example` como referência para os nomes das variáveis, nunca como arquivo com credenciais reais. Não publique `.env` no Git, não inclua seu conteúdo em prints e não o envie a terceiros.

## Limites conhecidos da infraestrutura

O PDF de acessos fornece endpoints e credenciais, mas não define schema/tabelas MariaDB, nomes de databases/coleções MongoDB, convenções de chaves Redis, buckets/objetos MinIO nem tópicos/formato de mensagens MQTT. Por isso, o dashboard faz inventário e consultas genéricas sem presumir a estrutura de negócio. O MongoDB lista databases que a conta tem permissão para listar; Redis mostra o database selecionado pela conexão; MinIO limita a amostra para não percorrer todo o armazenamento.

As conexões descritas no PDF são TCP sem TLS. Use somente a infraestrutura autorizada da turma. O MQTT está inicialmente configurado com `MQTT_TOPIC=#`; quando o tópico exato do Grupo 1 for confirmado, substitua por um filtro específico.

## Diagnóstico

```bash
docker compose ps
docker compose logs --tail=100 dashboard-grupo1
```

Os estados Offline indicam que o backend não conseguiu consultar o serviço. Verifique conectividade de rede, credenciais e permissões. O dashboard não altera nem grava dados nos bancos: faz apenas consultas de leitura e inventário.
