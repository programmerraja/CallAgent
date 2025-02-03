We are living in the era of AI agents, where people are increasingly developing these tools to automate mundane tasks. Today, we’ll explore how to build our own call agent using Twilio and ElevenLabs. While our primary focus will be on understanding how the system works and its architecture, I’ll provide the relevant code and additional resources at the end of the blog for those interested in digging deeper.

Introduction to ElevenLabs and Twilio
If you're not yet familiar with ElevenLabs, let me quickly introduce it. ElevenLabs is an AI platform that allows you to convert audio to text and vice versa. It features advanced AI audio models that generate realistic, versatile, and contextually aware speech, voices, and sound effects across 32 languages. For more information, check out their official page.

Twilio, on the other hand, is a cloud communications platform that enables developers to integrate messaging, voice, and video capabilities into applications. It provides APIs for SMS, voice calls, email, and more. Businesses use Twilio to connect with customers via various communication channels.

Building the Outgoing Call Agent
Prerequisites:
ElevenLabs account (10k free credits)
Twilio account with an active phone number
flow diagram

First we will initiate the call with Twilio and set up the stream as follows: (we passed the to number in query params check the code for more details)

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
Twilio Streams is a feature that allows you to access raw audio from your Programmable Voice calls. By sending the live audio stream to a destination of your choice using WebSockets, you can build use cases like real-time transcriptions, sentiment analysis, voice authentication, and more. For more details, check out Twilio's documentation on Streams.

Once the call is connected, Twilio establishes a WebSocket connection with our server. When we successfully receive this connection, we’ll begin receiving the following events:

start – Triggered when the call starts.
media – Incoming media (audio) from Twilio in Base64 format.
stop – Triggered when the call ends.
We will also generate a signed URL for the ElevenLabs agent. Once the WebSocket connection with ElevenLabs is established, we will start receiving the following events:

conversation_initiation_metadata – Contains metadata when the connection is established. For our purposes, we can ignore this.
audio – The agent’s audio in Base64 format.
interruption – Triggered whenever the user interrupts the agent’s speech. Upon receiving this event, we need to clear the Twilio audio buffer so the agent stops speaking and responds to the user’s interruption.
ping – Used to check the connection status.
With two active WebSocket connections (one to Twilio and one to ElevenLabs), we can now pipe the user’s audio to the agent and vice versa. This creates a realtime communication flow between the agent and the user, facilitating an interactive, automated phone call.

// Handle WebSocket connection from Twilio
websocket.on("connection", async (ws) => {
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
              user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
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

      elevenWs.on("open", () => console.log("Connected to Eleven Labs"));
      elevenWs.on("message", (data) => handleElevenLabsMessages(JSON.parse(data)));
      elevenWs.on("error", (error) => console.error("Error with Eleven Labs WebSocket:", error));
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
          const audioData = { event: "media", streamSid, media: { payload: message.audio.chunk || message.audio_event.audio_base_64 } };
          ws.send(JSON.stringify(audioData));
        }
        break;
      case "interruption":
        ws.send(JSON.stringify({ event: "clear", streamSid }));
        break;
      case "ping":
        if (message.ping_event?.event_id) {
          elevenWs.send(JSON.stringify({ type: "pong", event_id: message.ping_event.event_id }));
        }
        break;
      default:
        console.log(`Unhandled message type from Eleven Labs: ${message.type}`);
    }
  }
});


check out the blog [here](https://medium.com/@programmerraja/automating-conversations-building-a-smart-call-agent-using-twilio-and-elevenlabs-37b6acfba3eb)