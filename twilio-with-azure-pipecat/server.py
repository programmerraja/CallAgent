import argparse
import os
import json
import uvicorn
from agent import run_bot
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from twilio.rest import Client

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for testing
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def start_call():
    print("POST TwiML")

    client = Client(os.getenv("ACCOUNT_SID"), os.getenv("AUTH_TOKEN"))

    client.calls.create(
        from_=os.getenv("FROM"),
        to=os.getenv("To"),
        twiml="""<?xml version="1.0" encoding="UTF-8"?>
        <Response>
        <Connect>
            <Stream url="wss://SERVER_URL/media-stream" />
        </Connect>
        </Response>""",
    )


@app.websocket("/media-stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    start_data = websocket.iter_text()
    await start_data.__anext__()
    call_data = json.loads(await start_data.__anext__())
    print(call_data, flush=True)
    stream_sid = call_data["start"]["streamSid"]
    print("WebSocket connection accepted")
    await run_bot(websocket, stream_sid, app.state.testing)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pipecat Twilio Chatbot Server")
    parser.add_argument(
        "-t",
        "--test",
        action="store_true",
        default=False,
        help="set the server in testing mode",
    )
    args, _ = parser.parse_known_args()

    app.state.testing = args.test

    uvicorn.run(app, host="0.0.0.0", port=5050)
