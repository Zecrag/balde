#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "=== Instalador do Balde ==="

if ! command -v node &> /dev/null; then
    echo "Erro: Node.js não está instalado."
    echo "Por favor, instale o Node.js 20+ (https://nodejs.org/) e tente novamente."
    read -p "Pressione Enter para sair..."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "Erro: Node.js precisa ser versão 20 ou superior (encontrado: v$NODE_VERSION)."
    echo "Por favor, atualize o Node.js (https://nodejs.org/) e tente novamente."
    read -p "Pressione Enter para sair..."
    exit 1
fi

echo "Node.js v$NODE_VERSION detectado."

if [ -d "conectores/baileys" ]; then
    echo "Instalando dependências do conector Baileys..."
    cd conectores/baileys
    npm install
    cd ../..
fi

if [ ! -f .env ]; then
    echo "Criando .env a partir do exemplo..."
    cp .env.example .env
fi

echo "Instalando serviço em background (launchd)..."
node bin/servico.mjs instalar

echo "Iniciando o servidor em background..."
node server.mjs &

sleep 2
echo "Abrindo o painel de configuração no navegador..."
open http://127.0.0.1:7391/setup

echo "Concluído! Pressione Enter para fechar esta janela."
read
