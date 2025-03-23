import WebSocket from "ws";
import express from "express";
import dotenv from "dotenv";
import Twilio from "twilio";
import {
  LangfuseGenerationClient,
  LangfuseSpanClient,
  LangfuseTraceClient,
  Langfuse,
} from "langfuse";

import {
  Document,
  VectorStoreIndex,
  Settings,
  SentenceSplitter,
  RetrieverQueryEngine,
  TextNode,
} from "llamaindex";
import { QdrantVectorStore } from "@llamaindex/qdrant";
import { OpenAI, OpenAIEmbedding } from "@llamaindex/openai";

dotenv.config({ path: "../.env" });

Settings.llm = new OpenAI({
  model: "gpt-4o-mini",
});

Settings.embedModel = new OpenAIEmbedding({
  model: "text-embedding-3-large",
});

const PORT = process.env.PORT || 5050;

interface ToolDefinition {
  type?: "function";
  name: string;
  description: string;
  parameters?: Record<string, any>;
}
type AudioFormatType = "pcm16" | "g711_ulaw" | "g711_alaw";

interface AudioTranscription {
  model: "whisper-1";
}

interface TurnDetectionServerVad {
  type: "server_vad";
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
}

interface SessionConfig {
  model?: string;
  modalities?: string[];
  instructions?: string;
  voice?: "alloy" | "shimmer" | "echo";
  input_audio_format?: AudioFormatType;
  output_audio_format?: AudioFormatType;
  input_audio_transcription?: AudioTranscription | null;
  turn_detection?: TurnDetectionServerVad | null;
  tools?: ToolDefinition[];
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string };
  temperature?: number;
  max_response_output_tokens?: number | "inf";
}

class RAGWrapper {
  retriever: RetrieverQueryEngine;
  constructor() {}

  async setUp() {
    this.retriever = (
      await VectorStoreIndex.fromVectorStore(
        new QdrantVectorStore({
          url: process.env.QUADRANT_URL,
          collectionName: process.env.QUADRANT_COLLECTION,
        })
      )
    ).asQueryEngine();
  }

  async getRelvantContext(query: string): Promise<string> {
    const { message, sourceNodes } = await this.retriever.query({
      query,
    });
    let context = `CONTEXT\n`;
    if (sourceNodes) {
      sourceNodes.forEach((source, index) => {
        context += (source.node as TextNode).text;
      });
    }
    return context;
  }
}

class OpenAIHandler {
  private ws: WebSocket | null = null;

  async connect(onResponseCallback: (data: any) => void): Promise<void> {
    const realtimeCallback = new RealtimeCallback();
    try {
      this.ws = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        [],
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1",
          },
        }
      );
      const messages = [];
      this.ws.on("open", () => onResponseCallback({ type: "ws_open" }));
      this.ws.on("message", (data) => {
        const parsedData = JSON.parse(data.toString());
        if (!parsedData.type.includes("response.audio")) {
          console.log(data.toString());
          //  @ts-ingore
          messages.push(parsedData);
          //   fs.writeFileSync("./opeai.json", JSON.stringify(messages));
        }
        traceRealtimeEvent(parsedData, realtimeCallback);
        onResponseCallback(parsedData);
      });
      this.ws.on("error", (error) => console.error("WebSocket error:", error));
      this.ws.on("close", () => console.log("WebSocket closed"));
    } catch (error) {
      console.error("Error connecting to OpenAI:", error);
      throw error;
    }
  }

  updateSession(sessionConfig: SessionConfig): void {
    this.sendMessage({ type: "session.update", session: sessionConfig });
  }

  createConversation(prompt: string, tools?: ToolDefinition[]): void {
    this.sendMessage({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    });
    if (tools) {
      this.addTool(tools);
    }
    this.sendMessage({ type: "response.create" });
  }

  initializeSession(prompt: string): void {
    this.sendMessage({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad", threshold: 0.7 },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "echo",
        instructions: prompt,
        modalities: ["audio", "text"],
        temperature: 0.8,
        input_audio_transcription: { model: "whisper-1" },
      },
    });
  }

  addTool(tools: ToolDefinition[]): void {
    this.updateSession({ tools });
  }

  sendAudio(audio: string): void {
    this.sendMessage({ type: "input_audio_buffer.append", audio });
  }

  private sendMessage(message: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

const PROMPT = `
hai  
`;

class CallAgent {
  contextReteriver: RAGWrapper;
  openAIHandler: OpenAIHandler;
  twilio: ReturnType<typeof Twilio>;
  callInfo;
  twilioWs: WebSocket;
  openAIWs: WebSocket;
  streamSid: string;

  constructor(callInfo) {
    this.callInfo = callInfo;
    this.contextReteriver = new RAGWrapper();
    this.openAIHandler = new OpenAIHandler();
    this.twilio = Twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }

  async call() {
    await this.contextReteriver.setUp();

    this.twilio.calls.create({
      twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://9dd2-183-82-241-102.ngrok-free.app"/></Connect></Response>`,
      to: this.callInfo.to,
      from: this.callInfo.from,
    });

    this.openAIHandler.connect(this.openAImessageHandler.bind(this));
  }

  async openAImessageHandler(message) {
    switch (message.type) {
      case "ws_open":
        // TODO SYSTEM PTOMPT
        await this.openAIHandler.initializeSession(PROMPT);
        //ADD TOOL
        await this.openAIHandler.addTool([
          {
            type: "function",
            name: "context_retriever",
            description:
              "Retrieves the relevant context or knowledge based on a provided query during a call.",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description:
                    "A relevant query string used to fetch the required context.",
                },
              },
            },
          },
        ]);

      case "input_audio_buffer.speech_started":
        if (this.twilioWs)
          this.twilioWs.send(
            JSON.stringify({
              event: "clear",
              streamSid: this.streamSid,
            })
          );
        break;

      case "response.audio.delta":
        if (this.twilioWs)
          this.twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid: this.streamSid,
              media: { payload: message.delta },
            })
          );
        break;

      case "conversation.interrupted":
        break;

      case "conversation.item.input_audio_transcription.completed":
        break;
      case "response.content_part.done":
        console.log("response.content_part.done", message);
        break;
      case "conversation.item.created":
        break;
      case "response.function_call_arguments.done":
        const context = await this.contextReteriver.getRelvantContext(
          JSON.parse(message.arguments)
        );
        console.log("CONTEXT GOT", context, JSON.parse(message.arguments));
        if (context) {
          this.openAIHandler.createConversation(context);
        }
        break;
      case "response.content_part.done":
        console.log("response.content_part.done", message);
        break;
      case "error":
        console.error("Error:", message.error);
        break;
    }
  }

  twilioMessageHandler(message) {
    this.streamSid = message.streamSid;
    if (message.event === "media") {
      this.openAIHandler.sendAudio(message.media.payload);
    }
  }

  setTwilioWs(ws: WebSocket) {
    if (!this.twilioWs) {
      this.twilioWs = ws;
    }
  }
}
const app = express();

const callAgent = new CallAgent({
  from: `+${process.env.FROM_NUMBER}`,
  to: `+${process.env.TO_NUMBER}`,
});

app.get("/trigger-call", async (req, res) => {
  callAgent.call();
  await res.json({ message: "Call initiated successfully." });
});

const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", async (websocket) => {
  callAgent.setTwilioWs(websocket);
  websocket.on("message", async (message: any) => {
    callAgent.twilioMessageHandler(JSON.parse(message));
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

type RealtimeUsage = {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_token_details: {
    cached_tokens: number;
    text_tokens: number;
    audio_tokens: number;
  };
  output_token_details: {
    text_tokens: number;
    audio_tokens: number;
  };
};

class RealtimeCallback {
  trace: LangfuseTraceClient | null = null;
  spans: Record<string, LangfuseGenerationClient | LangfuseSpanClient> = {};

  constructor() {
    const langfuse = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET,
      publicKey: process.env.LANGFUSE_PUBLIC,
      baseUrl: process.env.LANGFUSE_HOST,
    });
    this.trace = langfuse.trace({
      sessionId: "test" + Math.random() * 1000,
      userId: "call-agent",
    });
  }

  onUserMessage(
    id: string,
    status: string,
    content: {
      type: "input_text" | "input_audio";
      text: string | undefined;
      audio: string;
      transcript: string;
    }[]
  ) {
    const span = this.trace.span({
      name: "UserMessage",
      input: content.map((item) => {
        let text: string | undefined;
        const trimmedText = item.text?.trim();

        if (trimmedText) {
          text = trimmedText;
        } else if (isNotEmptyString(item.transcript)) {
          text = `<voice>${item.transcript.trim()}</voice>`;
        } else {
          text = undefined;
        }

        return {
          id,
          type: item.type,
          text,
        };
      }),
    });

    if (content.every((c) => c.type === "input_text")) {
      span.end();
    } else {
      this.spans[id] = span;
    }
  }

  onUserAudioTranscript(id: string, transcript: string, error?: unknown) {
    const span: LangfuseSpanClient = this.spans[id];

    if (!span) return;

    const hasTranscript = isNotEmptyString(transcript);
    const hasError = isNotEmptyObject(error);

    const outputData: { text?: string; error?: unknown } = {};

    if (hasTranscript) {
      outputData.text = `<voice>${transcript.trim()}</voice>`;
    }
    if (hasError) {
      outputData.error = error;
    }

    const spanOptions: { output: typeof outputData; level?: "ERROR" } = {
      output: outputData,
    };
    if (hasError) {
      spanOptions.level = "ERROR";
    }

    span.end(spanOptions);
    delete this.spans[id];
  }

  onToolCall(id: string, name: string, args: Record<string, unknown>) {
    const span = this.trace.span({
      name: "ToolCall",
      input: {
        id,
        name,
        arguments: JSON.stringify(args),
      },
    });
    this.spans[id] = span;
  }

  onToolCallResponse(
    id: string,
    args: Record<string, unknown>,
    output: Record<string, unknown>
  ) {
    const span = this.spans[id];
    if (!span) return;
    span.end({
      output: {
        arguments: JSON.stringify(args),
        output: JSON.stringify(output),
      },
    });
    delete this.spans[id];
  }

  onAiResponseCreated(id: string) {
    const generation = this.trace.generation({
      name: "AiResponse",
      model: "gpt-4o-realtime-preview",
      input: {
        id,
      },
    });
    this.spans[id] = generation;
  }

  onAiResponseDone(
    id: string,
    output: Record<string, unknown>[],
    error?: Record<string, unknown>,
    usage?: RealtimeUsage
  ) {
    const generation: LangfuseGenerationClient = this.spans[id];
    if (!generation) return;

    const hasError = isNotEmptyObject(error);

    const outputData: { output: any; error?: any } = { output };

    if (hasError) {
      outputData.error = error;
    }

    const endOptions: {
      output: typeof outputData;
      level?: "ERROR";
      usage?: any;
    } = {
      output: outputData,
    };

    if (hasError) {
      endOptions.level = "ERROR";
    }

    if (isNotEmptyObject(usage)) {
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens;

      const inputTextTokens = usage.input_token_details?.text_tokens || 0;
      const inputAudioTokens = usage.input_token_details?.audio_tokens || 0;
      const inputCost =
        (inputTextTokens / 1e6) * 5 + (inputAudioTokens / 1e6) * 100;

      const outputTextTokens = usage.output_token_details?.text_tokens || 0;
      const outputAudioTokens = usage.output_token_details?.audio_tokens || 0;
      const outputCost =
        (outputTextTokens / 1e6) * 20 + (outputAudioTokens / 1e6) * 200;

      endOptions.usage = {
        input: inputTokens,
        output: outputTokens,
        inputCost,
        outputCost,
      };
    }

    generation.end(endOptions);

    delete this.spans[id];
  }

  onAiAudioTranscript(
    id: string,
    transcript: string,
    error?: Record<string, string>
  ) {
    const hasTranscript = isNotEmptyString(transcript);

    const hasError = isNotEmptyObject(error);
    const outputData: { text?: string; error?: unknown } = {};

    if (hasTranscript) {
      outputData.text = `<voice>${transcript.trim()}</voice>`;
    }
    if (hasError) {
      outputData.error = error;
    }

    const spanConfig: {
      name: string;
      input: { id: string };
      output: typeof outputData;
      level?: "ERROR";
    } = {
      name: "AiMessage",
      input: { id },
      output: outputData,
    };

    if (hasError) {
      spanConfig.level = "ERROR";
    }

    const span = this.trace.span(spanConfig);
    span.end();
  }

  close() {
    for (const [id, span] of Object.entries(this.spans)) {
      span.end({
        output: "NO_OUTPUT",
      });
      delete this.spans[id];
    }
  }
}

function traceRealtimeEvent(event: any, callback: RealtimeCallback) {
  switch (event.type) {
    case "conversation.item.created": {
      const { item } = event;

      if (!isNotEmptyObject(item)) return;

      const { id, type, role, status, content } = item;

      if (!isNotEmptyString(id)) return;

      if (type === "message" && role === "user") {
        callback.onUserMessage(id, status, content);
      } else if (type === "function_call") {
        const { call_id, name } = item;
        if (!isNotEmptyString(call_id)) return;
        callback.onToolCall(call_id, name, item.arguments);
      } else if (type === "function_call_output") {
        const { call_id, output } = item;
        if (!isNotEmptyString(call_id)) return;
        callback.onToolCallResponse(call_id, item.arguments, output);
      }
      return;
    }

    case "conversation.item.input_audio_transcription.completed": {
      const { item_id, transcript } = event;
      if (!isNotEmptyString(item_id) || !isNotEmptyString(transcript)) return;
      callback.onUserAudioTranscript(item_id, transcript);
      return;
    }

    case "response.audio_transcript.done": {
      const { item_id, transcript } = event;
      if (!isNotEmptyString(item_id) || !isNotEmptyString(transcript)) return;
      callback.onAiAudioTranscript(item_id, transcript);
      return;
    }

    case "conversation.item.input_audio_transcription.failed": {
      const { item_id, error } = event;
      if (!isNotEmptyString(item_id)) return;
      callback.onUserAudioTranscript(item_id, "", error);
      return;
    }

    case "response.created": {
      const { response } = event;
      if (!isNotEmptyObject(response)) return;
      const { id } = response;
      if (!isNotEmptyString(id)) return;
      callback.onAiResponseCreated(id);
      return;
    }

    case "response.done": {
      const { response } = event;
      if (!isNotEmptyObject(response)) return;
      const { id, status, status_details, output, usage } = response;
      if (!isNotEmptyString(id)) return;

      const outputNoAudio: any[] = [];

      if (isNotEmptyArray(output)) {
        output.forEach((item: any) => {
          let validItem: any = {};
          let validContent: any = {};

          if (isNotEmptyObject(item)) {
            validItem = { ...item };

            if (isNotEmptyObject(item.content)) {
              validContent = { ...item.content };
            }
          }

          validContent.audio = undefined;

          outputNoAudio.push({
            ...validItem,
            content: validContent,
          });
        });
      }
      const error = status !== "failed" ? undefined : status_details;
      callback.onAiResponseDone(id, outputNoAudio, error, usage);
      return;
    }
  }
}

function isNotEmptyObject(value: any): boolean {
  return (
    value !== null && typeof value === "object" && Object.keys(value).length > 0
  );
}

function isNotEmptyString(value: any): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isNotEmptyArray(value: any): boolean {
  return Array.isArray(value) && value.length > 0;
}
