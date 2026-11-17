# Servidor de transcrição do Compêndio Codex

## Requisitos

- Node.js 20 ou superior
- Chave de API da AssemblyAI
- Hospedagem com HTTPS
- Espaço temporário em disco para receber os áudios

## Instalação

1. Copie os arquivos para o servidor.
2. Execute `npm install`.
3. Copie `.env.example` para `.env`.
4. Coloque a chave da AssemblyAI em `ASSEMBLYAI_API_KEY`.
5. Configure `PORT`, se necessário.
6. Execute `npm start`.

## Endereços

Verificação:

GET /health

Transcrição:

POST /api/transcribe

O campo multipart obrigatório é `audio`.

## Funcionamento

1. O servidor recebe o áudio.
2. Envia o arquivo para a AssemblyAI.
3. Solicita transcrição com detecção de idioma e diarização.
4. Aguarda a conclusão.
5. Devolve texto e falas com locutor e timestamps.
6. Apaga o arquivo temporário recebido.

## Segurança

- Use HTTPS.
- Mantenha o arquivo `.env` fora do controle de versão.
- Nunca coloque a chave da AssemblyAI no APK.
- Configure limites de requisições e de tamanho de arquivo.
- O servidor deve ficar atrás de uma infraestrutura com limites de conexão e proteção contra abuso.
- O limite por endereço IP não substitui autenticação de usuário em uma implantação pública.
