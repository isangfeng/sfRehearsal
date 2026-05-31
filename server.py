#!/usr/bin/env python3
"""Local static server and speech synthesis endpoints."""

import base64
import json
import os
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent
MODEL_CACHE_DIR = PROJECT_DIR / ".models" / "huggingface"
NLTK_DATA_DIR = PROJECT_DIR / ".models" / "nltk_data"
os.environ.setdefault("HF_HOME", str(MODEL_CACHE_DIR))
os.environ.setdefault("NLTK_DATA", str(NLTK_DATA_DIR))

HOST = "127.0.0.1"
PORT = 8000
CONFIG_PATH = Path(__file__).with_name("config.local.json")
EXAMPLE_CONFIG_PATH = Path(__file__).with_name("config.example.json")
MELOTTS_DEVICE = os.environ.get("MELOTTS_DEVICE", "cpu")
MELOTTS_LANGUAGE = "ZH"
MELOTTS_SPEAKER = "ZH"
MODEL = None
MODEL_LOCK = threading.Lock()
ELEVENLABS_API_BASE = "https://api.elevenlabs.io"
DOUBAO_TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"


class MeloTTSUnavailable(RuntimeError):
    pass


class ElevenLabsUnavailable(RuntimeError):
    pass


class DoubaoUnavailable(RuntimeError):
    pass


def get_model():
    global MODEL

    if MODEL is not None:
        return MODEL

    with MODEL_LOCK:
        if MODEL is not None:
            return MODEL
        try:
            from melo.api import TTS
        except ImportError as error:
            raise MeloTTSUnavailable(
                "尚未安装 MeloTTS。请按照 README 中的步骤完成本地安装。"
            ) from error

        try:
            MODEL = TTS(language=MELOTTS_LANGUAGE, device=MELOTTS_DEVICE)
        except Exception as error:
            raise MeloTTSUnavailable(
                f"MeloTTS 初始化失败：{error}"
            ) from error
        return MODEL


def synthesize_melotts_speech(text, speed):
    model = get_model()
    speaker_ids = model.hps.data.spk2id
    if MELOTTS_SPEAKER not in speaker_ids:
        raise MeloTTSUnavailable("MeloTTS 中文音色 ZH 不可用。")

    output_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output_file:
            output_path = output_file.name
        model.tts_to_file(
            text,
            speaker_ids[MELOTTS_SPEAKER],
            output_path,
            speed=speed,
            quiet=True,
        )
        return Path(output_path).read_bytes()
    finally:
        if output_path:
            Path(output_path).unlink(missing_ok=True)


def get_elevenlabs_config():
    config = load_local_config().get("elevenlabs", {})
    api_key = os.environ.get("ELEVENLABS_API_KEY") or str(config.get("api_key", "")).strip()
    return {
        "api_key": api_key,
        "model_id": str(config.get("model_id", "eleven_multilingual_v2")).strip()
        or "eleven_multilingual_v2",
        "default_voice_id": str(config.get("default_voice_id", "")).strip(),
    }


def request_elevenlabs(path, *, method="GET", payload=None):
    config = get_elevenlabs_config()
    if not config["api_key"]:
        raise ElevenLabsUnavailable(
            "尚未配置 ElevenLabs API 密钥。请设置 ELEVENLABS_API_KEY 或修改 config.local.json。"
        )

    body = None
    headers = {"xi-api-key": config["api_key"]}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        f"{ELEVENLABS_API_BASE}{path}",
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read(), response.headers.get_content_type()
    except urllib.error.HTTPError as error:
        message = error.read().decode("utf-8", errors="replace")
        if error.code == 402:
            raise ElevenLabsUnavailable(
                "这个 ElevenLabs 音色不能通过当前套餐的 API 使用。"
                "请改用默认音色，或升级 ElevenLabs 套餐。"
            ) from error
        raise ElevenLabsUnavailable(
            f"ElevenLabs 请求失败（HTTP {error.code}）：{message[:300]}"
        ) from error
    except urllib.error.URLError as error:
        raise ElevenLabsUnavailable(f"无法连接 ElevenLabs：{error.reason}") from error


def list_elevenlabs_voices():
    query = urllib.parse.urlencode({"page_size": 100, "include_total_count": "false"})
    body, _ = request_elevenlabs(f"/v2/voices?{query}")
    data = json.loads(body)
    return [
        {"voice_id": voice["voice_id"], "name": voice["name"]}
        for voice in data.get("voices", [])
        if voice.get("voice_id") and voice.get("name")
        and (voice.get("sharing") or {}).get("status") != "copied"
    ]


def choose_elevenlabs_voice(voices, preferred_voice_id=""):
    if preferred_voice_id and any(
        voice["voice_id"] == preferred_voice_id for voice in voices
    ):
        return preferred_voice_id
    if voices:
        return voices[0]["voice_id"]
    raise ElevenLabsUnavailable("当前 ElevenLabs 账户没有可用在线音色。")


def synthesize_elevenlabs_speech(text, voice_id):
    config = get_elevenlabs_config()
    if not voice_id:
        voice_id = choose_elevenlabs_voice(
            list_elevenlabs_voices(), config["default_voice_id"]
        )

    encoded_voice_id = urllib.parse.quote(voice_id, safe="")
    query = urllib.parse.urlencode({"output_format": "mp3_44100_128"})
    return request_elevenlabs(
        f"/v1/text-to-speech/{encoded_voice_id}?{query}",
        method="POST",
        payload={"text": text, "model_id": config["model_id"]},
    )


def get_doubao_config():
    config = load_local_config().get("doubao", {})
    default_voice_type = os.environ.get("DOUBAO_VOICE_TYPE") or str(
        config.get("voice_type", "")
    ).strip()
    voices = []
    for voice in config.get("voices", []):
        if not isinstance(voice, dict):
            continue
        voice_type = str(voice.get("voice_type", "")).strip()
        name = str(voice.get("name", "")).strip()
        if voice_type and name:
            voices.append({"voice_type": voice_type, "name": name})
    if default_voice_type and not any(
        voice["voice_type"] == default_voice_type for voice in voices
    ):
        voices.insert(0, {"voice_type": default_voice_type, "name": default_voice_type})
    return {
        "api_key": os.environ.get("DOUBAO_API_KEY")
        or str(config.get("api_key", "")).strip(),
        "app_id": os.environ.get("DOUBAO_APP_ID")
        or str(config.get("app_id", "")).strip(),
        "access_token": os.environ.get("DOUBAO_ACCESS_TOKEN")
        or str(config.get("access_token", "")).strip(),
        "resource_id": os.environ.get("DOUBAO_RESOURCE_ID")
        or str(config.get("resource_id", "seed-tts-2.0")).strip()
        or "seed-tts-2.0",
        "voice_type": default_voice_type,
        "voices": voices,
        "speed": float(config.get("speed", 1.0)),
    }


def synthesize_doubao_speech(text, speed, voice_type=""):
    config = get_doubao_config()
    voice_type = voice_type or config["voice_type"]
    has_credentials = config["api_key"] or (
        config["app_id"] and config["access_token"]
    )
    missing_fields = []
    if not has_credentials:
        missing_fields.append("api_key，或 app_id 和 access_token")
    if not voice_type:
        missing_fields.append("voice_type")
    if missing_fields:
        raise DoubaoUnavailable(
            "尚未完整配置豆包语音。请在 config.local.json 中填写："
            + "、".join(missing_fields)
            + "。"
        )
    payload = {
        "user": {"uid": "rehearsal-app"},
        "req_params": {
            "text": text,
            "speaker": voice_type,
            "audio_params": {
                "format": "mp3",
                "speech_rate": round((speed - 1) * 100),
            },
        },
    }
    headers = {
        "Content-Type": "application/json",
        "X-Api-Resource-Id": config["resource_id"],
        "X-Api-Request-Id": str(uuid.uuid4()),
    }
    if config["api_key"]:
        headers["X-Api-Key"] = config["api_key"]
    else:
        headers["X-Api-App-Id"] = config["app_id"]
        headers["X-Api-Access-Key"] = config["access_token"]
    request = urllib.request.Request(
        DOUBAO_TTS_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        message = error.read().decode("utf-8", errors="replace")
        raise DoubaoUnavailable(
            f"豆包语音请求失败（HTTP {error.code}）：{message[:300]}"
        ) from error
    except urllib.error.URLError as error:
        raise DoubaoUnavailable(f"无法连接豆包语音：{error.reason}") from error
    audio_parts = []
    try:
        for line in body.splitlines():
            if not line.startswith("data:"):
                continue
            result = json.loads(line.removeprefix("data:").strip())
            if result.get("data"):
                audio_parts.append(base64.b64decode(result["data"]))
            elif result.get("code") not in (0, 20000000):
                raise DoubaoUnavailable(
                    f"豆包语音生成失败（{result.get('code', '未知错误')}）："
                    f"{result.get('message', '没有返回音频')}"
                )
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise DoubaoUnavailable("豆包语音返回的音频数据格式不正确。") from error
    if not audio_parts:
        raise DoubaoUnavailable("豆包语音没有返回音频。")
    return b"".join(audio_parts), "audio/mpeg"


class RehearsalHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/config":
            self.send_json(200, load_config())
            return
        if self.path == "/api/elevenlabs/voices":
            try:
                voices = list_elevenlabs_voices()
                self.send_json(
                    200,
                    {
                        "voices": voices,
                        "selected_voice_id": choose_elevenlabs_voice(
                            voices, get_elevenlabs_config()["default_voice_id"]
                        ),
                    },
                )
            except ElevenLabsUnavailable as error:
                self.send_json(503, {"error": str(error)})
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(502, {"error": f"ElevenLabs 音色列表解析失败：{error}"})
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/tts":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length))
            text = str(data.get("text", "")).strip()
            provider = str(data.get("provider", "melotts")).strip()
            speed = float(data.get("speed", 1.0))
            voice_id = str(data.get("voice_id", "")).strip()
        except (TypeError, ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "请求格式不正确。"})
            return

        if not text:
            self.send_json(400, {"error": "台词不能为空。"})
            return
        if len(text) > 4000:
            self.send_json(400, {"error": "单句文字过长，请拆分后再生成。"})
            return
        if provider not in {"melotts", "elevenlabs", "doubao"}:
            self.send_json(400, {"error": "不支持的朗读来源。"})
            return
        if provider == "melotts" and not 0.5 <= speed <= 2.0:
            self.send_json(400, {"error": "语速必须在 0.5 到 2.0 之间。"})
            return
        if provider == "doubao" and not 0.1 <= speed <= 2.0:
            self.send_json(400, {"error": "豆包语音语速必须在 0.1 到 2.0 之间。"})
            return

        try:
            if provider == "elevenlabs":
                audio, content_type = synthesize_elevenlabs_speech(text, voice_id)
            elif provider == "doubao":
                audio, content_type = synthesize_doubao_speech(text, speed, voice_id)
            else:
                audio = synthesize_melotts_speech(text, speed)
                content_type = "audio/wav"
        except MeloTTSUnavailable as error:
            self.send_json(503, {"error": str(error)})
            return
        except ElevenLabsUnavailable as error:
            self.send_json(503, {"error": str(error)})
            return
        except DoubaoUnavailable as error:
            self.send_json(503, {"error": str(error)})
            return
        except Exception as error:
            self.send_json(500, {"error": f"语音生成失败：{error}"})
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def load_local_config():
    path = CONFIG_PATH if CONFIG_PATH.exists() else EXAMPLE_CONFIG_PATH
    try:
        with path.open(encoding="utf-8") as config_file:
            return json.load(config_file)
    except (OSError, ValueError, json.JSONDecodeError):
        return {}


def load_config():
    try:
        config = load_local_config()
        speed = float(config.get("melotts", {}).get("speed", 1.0))
        if not 0.5 <= speed <= 2.0:
            speed = 1.0
        elevenlabs = get_elevenlabs_config()
        doubao = get_doubao_config()
        doubao_speed = doubao["speed"]
        if not 0.1 <= doubao_speed <= 2.0:
            doubao_speed = 1.0
        return {
            "melotts": {"speed": speed},
            "elevenlabs": {
                "enabled": bool(elevenlabs["api_key"]),
                "default_voice_id": elevenlabs["default_voice_id"],
                "model_id": elevenlabs["model_id"],
            },
            "doubao": {
                "enabled": bool(
                    (
                        doubao["api_key"]
                        or (doubao["app_id"] and doubao["access_token"])
                    )
                    and doubao["voices"]
                ),
                "voices": doubao["voices"],
                "selected_voice_type": doubao["voice_type"],
                "speed": doubao_speed,
            },
        }
    except (OSError, ValueError, json.JSONDecodeError):
        return {
            "melotts": {"speed": 1.0},
            "elevenlabs": {"enabled": False, "default_voice_id": ""},
            "doubao": {
                "enabled": False,
                "voices": [],
                "selected_voice_type": "",
                "speed": 1.0,
            },
        }


if __name__ == "__main__":
    print(f"Rehearsal app: http://{HOST}:{PORT}")
    print(f"MeloTTS device: {MELOTTS_DEVICE}")
    print(f"MeloTTS model cache: {os.environ['HF_HOME']}")
    print(f"NLTK data: {os.environ['NLTK_DATA']}")
    print("The Chinese model loads when speech is generated for the first time.")
    print("Press Ctrl+C to stop.")
    server = ThreadingHTTPServer((HOST, PORT), RehearsalHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
