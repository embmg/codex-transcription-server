
import express from "express";
import helmet from "helmet";
import compression from "compression";
import multer from "multer";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 500);
const MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024;

const PREFIXO_TEMPORARIO = "codex-transcription-";
const TEMPO_LIMPEZA_MS = 24 * 60 * 60 * 1000;
const INTERVALO_LIMPEZA_MS = 6 * 60 * 60 * 1000;
const arquivosAtivos = new Set();

if (!API_KEY) {
    throw new Error("ASSEMBLYAI_API_KEY não foi configurada.");
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(compression());

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
        error: "Limite de solicitações atingido. Tente novamente mais tarde.",
        error_code: "rate_limit"
    }
});

const armazenamento = multer.diskStorage({
    destination: (_req, _file, callback) => {
        callback(null, os.tmpdir());
    },
    filename: (_req, _file, callback) => {
        callback(null, `${PREFIXO_TEMPORARIO}${randomUUID()}`);
    }
});

const upload = multer({
    storage: armazenamento,
    limits: {
        fileSize: MAX_AUDIO_BYTES,
        files: 1
    }
});

function registrarLog(nivel, evento, dados = {}) {
    const registro = {
        timestamp: new Date().toISOString(),
        level: nivel,
        event: evento,
        ...dados
    };

    const mensagem = JSON.stringify(registro);

    if (nivel === "error") {
        console.error(mensagem);
    } else {
        console.log(mensagem);
    }
}

async function limparArquivosTemporarios() {
    try {
        const arquivos = await fs.promises.readdir(os.tmpdir());
        const agora = Date.now();

        for (const nome of arquivos) {
            if (!nome.startsWith(PREFIXO_TEMPORARIO)) {
                continue;
            }

            const caminho = path.join(os.tmpdir(), nome);

            if (arquivosAtivos.has(caminho)) {
                continue;
            }

            try {
                const informacoes = await fs.promises.stat(caminho);

                if (
                    informacoes.isFile() &&
                    agora - informacoes.mtimeMs > TEMPO_LIMPEZA_MS
                ) {
                    await fs.promises.unlink(caminho);

                    registrarLog("info", "arquivo_temporario_removido", {
                        arquivo: nome
                    });
                }
            } catch (erro) {
                if (erro.code !== "ENOENT") {
                    registrarLog("error", "erro_limpeza_temporario", {
                        arquivo: nome,
                        error: erro.message
                    });
                }
            }
        }
    } catch (erro) {
        registrarLog("error", "erro_varredura_temporarios", {
            error: erro.message
        });
    }
}

limparArquivosTemporarios();

const rotinaLimpeza = setInterval(
    limparArquivosTemporarios,
    INTERVALO_LIMPEZA_MS
);

rotinaLimpeza.unref();

class ErroAssemblyAI extends Error {
    constructor(mensagem, status) {
        super(mensagem);
        this.name = "ErroAssemblyAI";
        this.status = status;
    }
}

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
        throw new ErroAssemblyAI(
            dados.error ||
            dados.message ||
            `AssemblyAI retornou HTTP ${resposta.status}.`,
            resposta.status
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
    const intervalos = [3000, 5000, 8000, 15000];
    let tentativa = 0;

    while (Date.now() < limite) {
        const resultado = await requisicaoAssemblyAI(
            `${API_BASE}/transcript/${encodeURIComponent(transcriptId)}`
        );

        if (resultado.status === "completed") {
            return resultado;
        }

        if (resultado.status === "error") {
            throw new Error(
                resultado.error ||
                "A AssemblyAI não conseguiu transcrever o áudio."
            );
        }

        const intervalo = intervalos[
            Math.min(tentativa, intervalos.length - 1)
        ];

        await delay(intervalo);
        tentativa++;
    }

    throw new Error("O processamento ultrapassou o tempo limite.");
}

const TIPOS_EVENTO = {
    LYRICS: "lyrics",
    MUSIC: "music",
    NOISE: "noise",
    INAUDIBLE: "inaudible",
    UNINTELLIGIBLE: "unintelligible"
};

const REGEX_EVENTOS = /<\/?(LYRICS|MUSIC|NOISE|INAUDIBLE|UNINTELLIGIBLE)\b[^>]*>/gi;

function adicionarSegmento(segmentos, texto, tipo, incluirVazio = false) {
    const conteudo = String(texto || "")
        .replace(/\s+/g, " ")
        .trim();

    if (conteudo || incluirVazio) {
        segmentos.push({
            type: tipo,
            text: conteudo
        });
    }
}

function processarSegmentos(texto) {
    const conteudo = String(texto || "");
    const segmentos = [];
    const regex = new RegExp(REGEX_EVENTOS.source, "gi");

    let cursor = 0;
    let tipoAtual = "speech";
    let possuiConteudoEvento = false;
    let correspondencia;

    while ((correspondencia = regex.exec(conteudo)) !== null) {
        const trechoAnterior = conteudo.slice(
            cursor,
            correspondencia.index
        );

        adicionarSegmento(
            segmentos,
            trechoAnterior,
            tipoAtual
        );

        if (tipoAtual !== "speech" && trechoAnterior.trim()) {
            possuiConteudoEvento = true;
        }

        const marcador = correspondencia[1].toUpperCase();
        const tipoMarcador = TIPOS_EVENTO[marcador];
        const fechamento = correspondencia[0].startsWith("</");

        if (fechamento) {
            if (tipoAtual !== "speech" && !possuiConteudoEvento) {
                adicionarSegmento(segmentos, "", tipoAtual, true);
            }

            tipoAtual = "speech";
            possuiConteudoEvento = false;
        } else {
            if (tipoAtual !== "speech" && !possuiConteudoEvento) {
                adicionarSegmento(segmentos, "", tipoAtual, true);
            }

            tipoAtual = tipoMarcador;
            possuiConteudoEvento = false;
        }

        cursor = regex.lastIndex;
    }

    const trechoFinal = conteudo.slice(cursor);

    adicionarSegmento(
        segmentos,
        trechoFinal,
        tipoAtual
    );

    if (tipoAtual !== "speech" && !possuiConteudoEvento) {
        const ultimo = segmentos[segmentos.length - 1];

        if (
            !ultimo ||
            ultimo.type !== tipoAtual ||
            ultimo.text !== ""
        ) {
            adicionarSegmento(segmentos, "", tipoAtual, true);
        }
    }

    const textoLimpo = segmentos
        .map(segmento => segmento.text)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    const tipos = [...new Set(
        segmentos.map(segmento => segmento.type)
    )];

    const tipoGeral = tipos.length === 1
        ? tipos[0]
        : tipos.length > 1
            ? "mixed"
            : "speech";

    return {
        text: textoLimpo,
        type: tipoGeral,
        segments: segmentos
    };
}

function limparTextoTranscricao(texto) {
    return processarSegmentos(texto).text;
}

function processarFala(fala) {
    const resultado = processarSegmentos(fala.text);

    return {
        speaker: fala.speaker || null,
        text: resultado.text,
        type: resultado.type,
        segments: resultado.segments,
        start: fala.start ?? 0,
        end: fala.end ?? 0
    };
}

function classificarErro(erro, etapa) {
    if (erro instanceof ErroAssemblyAI) {
        if (erro.status === 401 || erro.status === 403) {
            return {
                code: "authentication_error",
                status: 502,
                message: "O servidor não conseguiu autenticar o serviço de transcrição."
            };
        }

        if (erro.status === 429) {
            return {
                code: "service_rate_limit",
                status: 503,
                message: "O serviço de transcrição está temporariamente sobrecarregado. Tente novamente mais tarde."
            };
        }

        if (erro.status === 400 || erro.status === 422) {
            return {
                code: "invalid_audio",
                status: 422,
                message: "O serviço não conseguiu processar este áudio. Verifique se o arquivo está íntegro e em formato compatível."
            };
        }
    }

    if (
        erro.name === "TypeError" ||
        /fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(erro.message || "")
    ) {
        return {
            code: "connection_error",
            status: 502,
            message: "Não foi possível estabelecer comunicação com o serviço de transcrição."
        };
    }

    if (etapa === "aguardando_transcricao") {
        return {
            code: "transcription_failed",
            status: 502,
            message: "Não foi possível concluir a transcrição."
        };
    }

    return {
        code: "processing_error",
        status: 502,
        message: "Ocorreu uma falha durante o processamento do áudio."
    };
}

function receberAudio(req, res, next) {
    upload.single("audio")(req, res, erro => {
        if (!erro) {
            return next();
        }

        const tamanhoExcedido = erro.code === "LIMIT_FILE_SIZE";

        return res.status(tamanhoExcedido ? 413 : 400).json({
            text: null,
            utterances: [],
            error: tamanhoExcedido
                ? `O arquivo ultrapassa o limite de ${MAX_AUDIO_MB} MB.`
                : "Não foi possível receber o arquivo de áudio.",
            error_code: tamanhoExcedido
                ? "file_too_large"
                : "upload_error"
        });
    });
}

app.post(
    "/api/transcribe",
    limiteRequisicoes,
    receberAudio,
    async (req, res) => {
        const requestId = randomUUID();
        const arquivoTemporario = req.file?.path;

        let transcriptId = null;
        let etapa = "recebendo_audio";

        if (arquivoTemporario) {
            arquivosAtivos.add(arquivoTemporario);
        }

        try {
            if (!req.file) {
                return res.status(400).json({
                    text: null,
                    utterances: [],
                    error: "Nenhum arquivo de áudio foi recebido.",
                    error_code: "missing_audio"
                });
            }

            registrarLog("info", "transcricao_iniciada", {
                requestId,
                tamanhoBytes: req.file.size
            });

            etapa = "enviando_audio";

            const audioUrl = await enviarAudioAssemblyAI(
                arquivoTemporario
            );

            etapa = "criando_transcricao";

            const solicitacao = await solicitarTranscricao(audioUrl);

            if (!solicitacao.id) {
                throw new Error(
                    "A AssemblyAI não retornou o identificador da transcrição."
                );
            }

            transcriptId = solicitacao.id;

            registrarLog("info", "transcricao_criada", {
                requestId,
                transcriptId
            });

            etapa = "aguardando_transcricao";

            const resultado = await aguardarTranscricao(
                transcriptId
            );

            const utterances = (resultado.utterances || [])
                .map(processarFala);

            const textoCompleto = limparTextoTranscricao(
                resultado.text
            );

            registrarLog("info", "transcricao_concluida", {
                requestId,
                transcriptId,
                quantidadeFalas: utterances.length
            });

            return res.json({
                text: textoCompleto,
                utterances,
                error: null,
                error_code: null
            });

        } catch (erro) {
            const falha = classificarErro(erro, etapa);

            registrarLog("error", "transcricao_falhou", {
                requestId,
                transcriptId,
                etapa,
                error: erro.message,
                errorCode: falha.code
            });

            return res.status(falha.status).json({
                text: null,
                utterances: [],
                error: falha.message,
                error_code: falha.code
            });

        } finally {
            if (arquivoTemporario) {
                arquivosAtivos.delete(arquivoTemporario);

                try {
                    await fs.promises.unlink(arquivoTemporario);
                } catch (erro) {
                    if (erro.code !== "ENOENT") {
                        registrarLog("error", "erro_remocao_audio", {
                            requestId,
                            transcriptId,
                            error: erro.message
                        });
                    }
                }
            }
        }
    }
);

const servidor = app.listen(PORT, "0.0.0.0", () => {
    registrarLog("info", "servidor_iniciado", {
        porta: PORT
    });
});

servidor.requestTimeout = 0;
servidor.timeout = 0;
servidor.headersTimeout = 60000;
