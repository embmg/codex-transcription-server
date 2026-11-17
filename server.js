import express from "express";
import helmet from "helmet";
import multer from "multer";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 500);
const MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024;

if (!API_KEY) {
    throw new Error("ASSEMBLYAI_API_KEY não foi configurada.");
}

app.disable("x-powered-by");
app.use(helmet());

app.get("/", (_req, res) => {
    res.status(200).json({
        service: "Compêndio Codex - Servidor de Transcrição",
        status: "online",
        health: "/health"
    });
});

app.get("/health", (_req, res) => {
    res.status(200).json({
        status: "online",
        service: "codex-transcription-server"
    });
});

const limiteRequisicoes = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
        error: "Limite de solicitações atingido. Tente novamente mais tarde."
    }
});

const upload = multer({
    dest: os.tmpdir(),
    limits: {
        fileSize: MAX_AUDIO_BYTES,
        files: 1
    }
});

const API_BASE = "https://api.assemblyai.com/v2";

async function requisicaoAssemblyAI(url, options = {}) {
    const resposta = await fetch(url, {
        ...options,
        headers: {
            authorization: API_KEY,
            ...(options.headers || {})
        }
    });

    const texto = await resposta.text();

    let dados;

    try {
        dados = texto ? JSON.parse(texto) : {};
    } catch {
        dados = { error: texto };
    }

    if (!resposta.ok) {
        throw new Error(
            dados.error ||
            dados.message ||
            `AssemblyAI retornou HTTP ${resposta.status}.`
        );
    }

    return dados;
}

async function enviarAudioAssemblyAI(caminho) {
    const tamanho = fs.statSync(caminho).size;
    const fluxo = fs.createReadStream(caminho);

    const resposta = await requisicaoAssemblyAI(
        `${API_BASE}/upload`,
        {
            method: "POST",
            headers: {
                "content-type": "application/octet-stream",
                "content-length": String(tamanho)
            },
            body: fluxo,
            duplex: "half"
        }
    );

    if (!resposta.upload_url) {
        throw new Error("A AssemblyAI não retornou o endereço do áudio.");
    }

    return resposta.upload_url;
}

async function solicitarTranscricao(audioUrl) {
    return requisicaoAssemblyAI(
        `${API_BASE}/transcript`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({
                audio_url: audioUrl,
                speech_models: [
                    "universal-3-5-pro",
                    "universal-2"
                ],
                language_detection: true,
                speaker_labels: true,
                disfluencies: true,
                punctuate: true,
                format_text: false
            })
        }
    );
}

async function aguardarTranscricao(transcriptId) {
    const limite = Date.now() + 3 * 60 * 60 * 1000;

    while (Date.now() < limite) {
        const resultado = await requisicaoAssemblyAI(
            `${API_BASE}/transcript/${encodeURIComponent(transcriptId)}`
        );

        if (resultado.status === "completed") {
            return resultado;
        }

        if (resultado.status === "error") {
            throw new Error(
                resultado.error || "A AssemblyAI não conseguiu transcrever o áudio."
            );
        }

        await delay(3000);
    }

    throw new Error("O processamento ultrapassou o tempo limite.");
}

app.post(
    "/api/transcribe",
    limiteRequisicoes,
    upload.single("audio"),
    async (req, res) => {
        const arquivoTemporario = req.file?.path;

        try {
            if (!req.file) {
                return res.status(400).json({
                    error: "Nenhum arquivo de áudio foi recebido."
                });
            }

            const audioUrl = await enviarAudioAssemblyAI(
                arquivoTemporario
            );

            const solicitacao = await solicitarTranscricao(audioUrl);

            if (!solicitacao.id) {
                throw new Error("A AssemblyAI não retornou o identificador da transcrição.");
            }

            const resultado = await aguardarTranscricao(
                solicitacao.id
            );

            return res.json({
                text: resultado.text || "",
                utterances: (resultado.utterances || []).map(fala => ({
                    speaker: fala.speaker || null,
                    text: fala.text || "",
                    start: fala.start ?? 0,
                    end: fala.end ?? 0
                })),
                error: null
            });

        } catch (erro) {
            console.error("Erro na transcrição:", erro.message);

            return res.status(502).json({
                text: null,
                utterances: [],
                error: erro.message || "Falha ao processar a transcrição."
            });

        } finally {
            if (arquivoTemporario) {
                fs.promises.unlink(arquivoTemporario).catch(() => {});
            }
        }
    }
);

const servidor = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor de transcrição ativo na porta ${PORT}.`);
});

servidor.requestTimeout = 0;
servidor.timeout = 0;
servidor.headersTimeout = 60000;
