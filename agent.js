const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const Twilio = require("twilio");
const { createServer } = require("http");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(express.json());

const server = createServer(app);

const websocket = new WebSocketServer({ noServer: true });

// Endpoint to initiate an outbound call
app.get("/outbound-call", (req, res) => {
  const twilioClient = new Twilio(
    process.env.TWILIO_ACC, // Twilio Account SID from environment variables
    process.env.TWILIO_KEY // Twilio Auth Token from environment variables
  );

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${process.env.SERVER_URL}/outbound-stream" />
      </Connect>
    </Response>`;

  // Create the call using Twilio API and initiate the WebSocket stream
  twilioClient.calls
    .create({
      from: process.env.FROM_NUMBER,
      to: req.query.toNumber,
      twiml: twimlResponse, // The TwiML response containing WebSocket stream information
    })
    .then((call) => {
      res.send({
        success: true,
        message: "Call initiated",
        callSid: call.sid,
      });
    })
    .catch((error) => {
      res.status(500).send({
        success: false,
        message: "Failed to initiate call",
        error: error.message,
      });
    });
});
// Handle WebSocket connection from Twilio
websocket.on("connection", async (ws) => {
  let elevenWs;
  let streamSid;

  console.log("Stream connected from Twilio");

  // Set up the Eleven Labs WebSocket
  await setupElevenLabs();

  // Handle WebSocket errors
  ws.on("error", (err) => console.log("Error on Twilio WebSocket:", err));

  // Handle incoming messages from Twilio
  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message);
      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          console.log(`Started StreamSid ${streamSid}`);
          break;

        case "media":
          if (elevenWs?.readyState === WebSocket.OPEN) {
            console.log(`Received media from Twilio: StreamSid ${streamSid}`);
            const audioMessage = {
              user_audio_chunk: Buffer.from(
                msg.media.payload,
                "base64"
              ).toString("base64"),
            };
            elevenWs.send(JSON.stringify(audioMessage));
          }
          break;

        case "stop":
          if (elevenWs?.readyState === WebSocket.OPEN) elevenWs.close();
          console.log("Stream ended");
          break;

        default:
          console.log(`Unhandled event: ${msg.event}`);
      }
    } catch (error) {
      console.error("Error processing Twilio message:", error, streamSid);
    }
  });

  // Close connection
  ws.on("close", () => {
    console.log("Connection closed by Twilio");
    if (elevenWs?.readyState === WebSocket.OPEN) elevenWs.close();
  });

  // Set up Eleven Labs WebSocket
  async function setupElevenLabs() {
    try {
      const { data } = await axios.get(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.AGENT_ID}`,
        { headers: { "xi-api-key": process.env.API_KEY } }
      );
      elevenWs = new WebSocket(data.signed_url);

      // elevenWs = new WebSocket("ws://localhost:7860/ws");

      elevenWs.on("open", () => console.log("Connected to Eleven Labs"));
      elevenWs.on("message", (data) =>
        handleElevenLabsMessages(JSON.parse(data))
      );
      elevenWs.on("error", (error) =>
        console.error("Error with Eleven Labs WebSocket:", error)
      );
      elevenWs.on("close", () => console.log("Disconnected from Eleven Labs"));
    } catch (error) {
      console.error("Error setting up Eleven Labs WebSocket:", error);
    }
  }

  // Handle Eleven Labs WebSocket messages
  function handleElevenLabsMessages(message) {
    switch (message.type) {
      case "audio":
        if (streamSid) {
          const audioData = {
            event: "media",
            streamSid,
            media: {
              payload: message.audio_event.audio_base_64 || message.audio.chunk,
            },
          };
          ws.send(JSON.stringify(audioData));
        }
        break;
      case "interruption":
        ws.send(JSON.stringify({ event: "clear", streamSid }));
        break;
      case "ping":
        if (message.ping_event?.event_id) {
          elevenWs.send(
            JSON.stringify({
              type: "pong",
              event_id: message.ping_event.event_id,
            })
          );
        }
        break;
      default:
        console.log(`Unhandled message type from Eleven Labs: ${message.type}`);
    }
  }
});

websocket.on("error", (error) => {
  console.error("Error on Twilio WebSocket:", error);
});

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`)
    .pathname;

  console.log("RECEIVED UPGRADE ON", pathname);

  if (pathname === "/outbound-stream") {
    websocket.handleUpgrade(request, socket, head, (ws) => {
      websocket.emit("connection", ws, request);
    });
  }
});

// Start the server on port 8080
server.listen(8080, () => {
  console.log(`Server is running on port 8080`);
});
