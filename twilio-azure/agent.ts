import WebSocket from "ws";
import express from "express";
import dotenv from "dotenv";
import Twilio from "twilio";
import axios from "axios";
import { AzureOpenAI } from "openai";
import fs from "fs";
import * as uuid from "uuid";
import {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources/index.mjs";
import Content from "twilio/lib/rest/Content";

import * as speechSdk from "microsoft-cognitiveservices-speech-sdk";
import EventEmitter from "events";

import { WaveFile } from "wavefile";

dotenv.config({ path: "../.env" });

const PORT = process.env.PORT || 5050;
// console.log = () => {};

function getTimestamp() {
  return new Date().toISOString().replace(/Z$/, "") + "Z";
}

function getSSML(text) {
  const voice = "zh-CN-YunyangNeural";
  return `
        <speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN">
            <voice name="${voice}">
               ${text}
            </voice>
        </speak>
    `;
}

abstract class baseWorkflow {
  pipe(consumer): baseWorkflow {
    return consumer;
  }

  listener(data) {}
}

// class AzureTTS extends baseWorkflow {
//   ws: WebSocket;
//   requestId;
//   consumer: baseWorkflow;
//   constructor() {
//     super();
//     this.requestId = uuid.v4().replace(/-/g, "").toUpperCase();
//   }

//   async connect() {
//     if (this.ws) {
//       return;
//     }
//     const authToken = await this.getAzureAuthToken();
//     await new Promise((res, rej) => {
//       this.ws = new WebSocket(
//         `wss://eastus.tts.speech.microsoft.com/cognitiveservices/websocket/v1?Authorization=${authToken}&X-ConnectionId=${this.requestId}`
//       );

//       this.ws.on("open", () => {
//         console.log("AZURE OPENED");
//         this.ws.send(
//           `Path : speech.config\r\nX-RequestId: ${
//             this.requestId
//           }\r\nX-Timestamp: ${getTimestamp()}\r\nContent-Type: application/json\r\n\r\n{"context":{"system":{"name":"SpeechSDK","version":"1.12.1","os":{"platform":"Node.js"}}}}`
//         );
//         this.ws.send(
//           `Path : synthesis.context\r\nX-RequestId: ${
//             this.requestId
//           }\r\nX-Timestamp: ${getTimestamp()}\r\nContent-Type: application/json\r\n\r\n{"synthesis":{"audio":{"outputFormat":"raw-8khz-8bit-mono-mulaw"}}}`
//         );
//         res("");
//       });
//       this.ws.on("message", (msg) => this.handleMessage(msg));

//       this.ws.on("error", (err) => console.log("AzureTTS", err));
//       this.ws.on("close", () => console.log("closed"));
//     });
//   }

//   handleMessage(data: any) {
//     const tdata = data.toString();
//     console.log("AZURE MESAGE");
//     if (typeof tdata === "string" && tdata.includes("Path:turn.end")) {
//       console.log("Azure TTS streaming complete.");
//     } else if (tdata.includes("Path:audio")) {
//       const dataView = new DataView(data.buffer);

//       const headerLength = dataView.getInt16(0);

//       let body = "";

//       if (data.byteLength > headerLength + 2) {
//         body = data.slice(2 + headerLength);
//       }

//       this.consumer.listener(Buffer.from(body).toString("base64"));
//     }
//   }

//   sendText(text) {
//     console.log("[AZURETTS] REQUEST", text);
//     this.ws.send(
//       `Path: ssml\r\nX-RequestId: ${
//         this.requestId
//       }\r\nX-Timestamp: ${getTimestamp()}\r\nContent-Type: application/ssml+xml\r\n\r\n${getSSML(
//         text
//       )}`
//     );
//   }

//   async getAzureAuthToken() {
//     const response = await axios.post(
//       "https://eastus.api.cognitive.microsoft.com/sts/v1.0/issueToken",
//       {},
//       {
//         headers: {
//           "Content-type": "application/x-www-form-urlencoded",
//           "Ocp-Apim-Subscription-Key": process.env.AZURE_TTS_TOKEN,
//         },
//       }
//     );
//     return response.data;
//   }

//   pipe(consumer: baseWorkflow) {
//     this.consumer = consumer;
//     return consumer;
//   }

//   async listener(data) {
//     this.sendText(data);
//   }
// }

class AzureTTS extends baseWorkflow {
  synthesizer: speechSdk.SpeechSynthesizer;
  consumer?: baseWorkflow;

  constructor() {
    super();
    const subscriptionKey = process.env.AZURE_TTS_TOKEN as string;
    const serviceRegion = "eastus";
    const speechConfig = speechSdk.SpeechConfig.fromSubscription(
      subscriptionKey,
      serviceRegion
    );
    speechConfig.speechSynthesisLanguage = "en-US";
    speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";
    speechConfig.speechSynthesisOutputFormat =
      speechSdk.SpeechSynthesisOutputFormat.Raw8Khz8BitMonoMULaw;

    const audioConfig = speechSdk.AudioConfig.fromDefaultSpeakerOutput();
    this.synthesizer = new speechSdk.SpeechSynthesizer(
      speechConfig,
      audioConfig
    );
  }

  sendText(text: string): void {
    console.log("[AZURETTS] REQUEST", text);
    this.synthesizer.speakTextAsync(
      text,
      (result) => {
        if (
          result.reason === speechSdk.ResultReason.SynthesizingAudioCompleted
        ) {
          console.log("Audio synthesis completed.");
          const base64Audio = Buffer.from(result.audioData).toString("base64");
          if (this.consumer) {
            console.timeEnd("AzureTTS");
            this.consumer.listener(base64Audio);
          }
        } else {
          console.error("Error during synthesis:", result.errorDetails);
          if (this.consumer) {
            this.consumer.listener(`Error: ${result.errorDetails}`);
          }
        }
      },
      (error) => {
        console.error("Synthesis error:", error);
        if (this.consumer) {
          this.consumer.listener(`Error: ${error}`);
        }
      }
    );
  }

  pipe(consumer: baseWorkflow): baseWorkflow {
    this.consumer = consumer;
    return consumer;
  }

  async listener(data: string): Promise<void> {
    console.time("AzureTTS");
    this.sendText(data);
  }
}

class AzureSTT extends baseWorkflow {
  pushStream;
  recognizer;
  convertedText = "";
  consumer;

  constructor() {
    super();
    const subscriptionKey = process.env.AZURE_TTS_TOKEN;
    const serviceRegion = "eastus";
    const speechConfig = speechSdk.SpeechConfig.fromSubscription(
      subscriptionKey,
      serviceRegion
    );
    speechConfig.speechRecognitionLanguage = "en-US";

    const audioFormat = speechSdk.AudioStreamFormat.getWaveFormatPCM(
      8000,
      16,
      1
    );

    this.pushStream = speechSdk.AudioInputStream.createPushStream(audioFormat);
    const audioConfig = speechSdk.AudioConfig.fromStreamInput(this.pushStream);

    this.recognizer = new speechSdk.SpeechRecognizer(speechConfig, audioConfig);

    this.setupEventHandlers();
    this.start();
  }

  setupEventHandlers() {
    this.recognizer.recognized = (s, e) => {
      if (e.result.reason === speechSdk.ResultReason.RecognizedSpeech) {
        console.log(`RECOGNIZED: Text=${e.result.text}`);
        this.convertedText += e.result.text.trim();
        if (this.consumer) {
          console.timeEnd("AzureSTT");
          this.consumer.listener(e.result.text.trim());
        }
      }
    };

    this.recognizer.canceled = (s, e) => {
      console.error(`CANCELED: ${e.reason}`);
      if (e.reason === speechSdk.CancellationReason.Error) {
        console.error(`CANCELED: ErrorCode=${e.errorCode}`);
        console.error(`CANCELED: ErrorDetails=${e.errorDetails}`);
        if (this.consumer) {
          this.consumer.listener(`Error: ${e.errorDetails}`);
        }
      }
    };

    this.recognizer.sessionStopped = (s, e) => {
      console.log("Azure Speech session stopped.");
      if (this.consumer) {
        this.consumer.listener("Session stopped");
      }
    };
  }

  async send(payload) {
    const buffer = Buffer.from(payload, "base64");
    const pcmBuffer = convertMuLawToPCM(buffer);
    this.pushStream.write(pcmBuffer);
  }

  start() {
    this.recognizer.startContinuousRecognitionAsync();
  }

  stop() {
    this.recognizer.stopContinuousRecognitionAsync(() => {
      this.pushStream.close();
    });
  }

  pipe(consumer) {
    this.consumer = consumer;
    return consumer;
  }

  async listener(data) {
    console.time("AzureSTT");
    this.send(data);
  }
}

class AzureOpenAIWrapper extends baseWorkflow {
  conversation: Array<
    ChatCompletionSystemMessageParam | ChatCompletionUserMessageParam
  > = [
    {
      role: "system",
      content:
        "You are an elementary teacher in an audio call. Your output will be converted to audio so don't include special characters in your answers. Respond to what the student said in a short short sentence.",
    },
  ];
  openAI: AzureOpenAI;
  consumer: baseWorkflow;
  constructor() {
    super();
    this.openAI = new AzureOpenAI({
      endpoint: process.env.AZURE_BASE_URL,
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      apiVersion: process.env.AZURE_API_VERSION,
    });
  }

  async handleMessage(data) {
    this.convert(data);
    console.log(this.conversation);
    console.time("AzureOPENAI");
    const response = await this.openAI.chat.completions.create({
      messages: this.conversation,
      model: "gpt-4o-mini",
    });
    console.log("[AzureOpenAI] RESPONSE", response.choices[0].message.content);
    this.consumer.listener(response.choices[0].message.content);
    console.timeEnd("AzureOPENAI");
    // const stream = await this.openAI.chat.completions.create({
    //   messages: this.conversation,
    //   model: "gpt-4o-mini",
    //   stream: true,
    // });

    // let fullResponse = "";
    // for await (const chunk of stream) {
    //   const content = chunk.choices[0]?.delta?.content;
    //   if (content) {
    //     fullResponse += content;
    //     this.consumer.listener(content);
    //   }
    // }

    // console.log("[AzureOpenAI] RESPONSE", fullResponse);
  }

  convert(data) {
    if (data) {
      this.conversation.push({ role: "user", content: data });
    }
  }

  pipe(consumer: baseWorkflow) {
    this.consumer = consumer;
    return consumer;
  }

  listener(data: any): void {
    console.log("[AzureOpenAI]", data);
    this.handleMessage(data);
  }
}

class TwilioWrapper extends baseWorkflow {
  consumer: baseWorkflow;
  ws: WebSocket;
  twilio: ReturnType<typeof Twilio>;
  streamSid: string;
  callInfo;

  constructor(callInfo) {
    super();
    this.callInfo = callInfo;
    this.twilio = Twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }

  setWs(ws) {
    if (!this.ws) {
      this.ws = ws;
    }
  }

  start() {
    this.twilio.calls.create({
      twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://2ad4-115-97-68-190.ngrok-free.app/media-stream"/></Connect></Response>`,
      to: this.callInfo.to,
      from: this.callInfo.from,
    });
  }

  messageHandler(message) {
    // console.log("message");
    this.streamSid = message.streamSid;
    if (message.event === "media") {
      this.consumer.listener(message.media.payload);
    }
  }

  pipe(consumer: baseWorkflow): baseWorkflow {
    this.consumer = consumer;
    return consumer;
  }

  listener(data: any): void {
    this.ws.send(
      JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: data },
      })
    );
  }
}

const app = express();

const callAgent = new TwilioWrapper({
  from: `+${process.env.FROM_NUMBER}`,
  to: `+${process.env.TO_NUMBER}`,
});

const azureSTT = new AzureSTT();
const azureTTS = new AzureTTS();
const azureOpenAI = new AzureOpenAIWrapper();

callAgent.pipe(azureSTT).pipe(azureOpenAI).pipe(azureTTS).pipe(callAgent);

app.get("/trigger-call", async (req, res) => {
  callAgent.start();
  await res.json({ message: "Call initiated successfully." });
});

const wss = new WebSocket.Server({ noServer: true });

function convertMuLawToPCM(muLawBuffer) {
  const pcmBuffer = Buffer.alloc(muLawBuffer.length * 2);
  for (let i = 0; i < muLawBuffer.length; i++) {
    const muLawByte = muLawBuffer[i];
    const pcmVal = muLawToLinear(muLawByte);
    pcmBuffer.writeInt16LE(pcmVal, i * 2);
  }
  return pcmBuffer;
  function muLawToLinear(muLawByte) {
    muLawByte = ~muLawByte & 0xff;
    const MULAW_BIAS = 33;
    const sign = muLawByte & 0x80;
    const exponent = (muLawByte >> 4) & 0x07;
    const mantissa = muLawByte & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    return sign !== 0 ? -sample : sample;
  }
}

wss.on("connection", async (websocket) => {
  callAgent.setWs(websocket);
  websocket.on("message", async (message: any) => {
    const data = JSON.parse(message);

    callAgent.messageHandler(JSON.parse(message));
    return;
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

server.on("upgrade", (request, socket, head) => {
  // @ts-ignore
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws);
  });
});

process.env.NODE_NO_WARNINGS = '1';
