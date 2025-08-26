require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const bodyParser = require("body-parser");
const { AzureChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

const app = express();
app.use(bodyParser.json());

// Gmail OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

// Initialize LangChain AzureChatOpenAI model
const azureModel = new AzureChatOpenAI({
  azureOpenAIApiKey: process.env.OPENAI_API_KEY,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT,
  azureOpenAIApiInstanceName: process.env.AZURE_INSTANCE_NAME,
  azureOpenAIApiVersion: process.env.apiVersion,
  temperature: 0.2,
});

// Track ongoing threads for follow-up replies
const ongoingThreads = new Map(); // threadId -> { lastProcessedEmailId }

const decodeBase64 = (data) => Buffer.from(data, "base64").toString("utf-8");

// Extract email content (headers, body, attachments)
const extractEmail = async (message) => {
  const payload = message.payload;
  const headers = {};
  payload.headers.forEach((h) => {
    if (["From", "To", "Subject", "Date"].includes(h.name))
      headers[h.name] = h.value;
  });

  let body = "";
  if (payload.parts) {
    payload.parts.forEach((part) => {
      if (part.mimeType === "text/plain" || part.mimeType === "text/html")
        body += decodeBase64(part.body.data);
    });
  } else {
    body = decodeBase64(payload.body.data);
  }

  const attachments = [];
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.filename && part.body && part.body.attachmentId) {
        const attachment = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: message.id,
          id: part.body.attachmentId,
        });
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          data: attachment.data.data,
        });
      }
    }
  }

  return {
    id: message.id,
    threadId: message.threadId,
    headers,
    body,
    attachments,
  };
};

// Function to analyze email body with AI (prefix Clarify: if clarification needed)
const analyzeEmailBody = async (body) => {
  const response = await azureModel.invoke([
    new SystemMessage(
      "You are an AI email assistant. " +
        "If the email is unclear and you need more information, respond with 'Clarify:' as the first word, followed by your question. " +
        "If you understand the instructions, respond normally without the 'Clarify:' prefix."
    ),
    new HumanMessage(
      `Analyze this email and extract instructions if possible.\n\nEmail: ${body}`
    ),
  ]);

  return response.content;
};

// Send Gmail reply
const sendEmailReply = async (to, subject, body, threadId, messageId) => {
  const rawMessage = [
    `From: md@bursement.com`,
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    `In-Reply-To: ${messageId}`,
    `References: ${messageId}`,
    "",
    body,
  ].join("\n");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: Buffer.from(rawMessage)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
      threadId, // 👈 this ensures Gmail groups it into same thread
    },
  });
};

// Process an email (new or reply)
const processEmail = async (message) => {
  const email = await extractEmail(message);
  const emailThreadId = email.threadId;
  const headers = message.payload.headers;
  // Find the Message-Id header
  const messageIdHeader = headers.find(
    (h) => h.name.toLowerCase() === "message-id"
  );
  const messageId = messageIdHeader ? messageIdHeader.value : null;
  const sender = email.headers.From;
  const subject = email.headers.Subject || "";

  // ✅ Skip if subject does not start with "Analysis:"
  if (!subject.startsWith("Analysis:")) {
    console.log(`Skipping email (not Analysis): ${subject}`);
    return;
  }

  try {
    const aiResponse = await analyzeEmailBody(email.body);

    if (aiResponse.startsWith("Clarify:")) {
      // AI needs clarification → send follow-up
      await sendEmailReply(
        sender,
        subject,
        aiResponse,
        emailThreadId,
        messageId
      );
      console.log(`Clarification sent to ${sender}`);
      ongoingThreads.set(email.threadId, { lastProcessedEmailId: email.id });
    } else {
      // AI understood → process instructions & attachments
      console.log("AI instructions:", aiResponse);
      console.log(
        "Attachments:",
        email.attachments.map((a) => a.filename)
      );

      // TODO: Custom processing logic for instructions & attachments

      // TODO: Call Open AI function calling tool with the processed input

      // Mark thread as completed
      ongoingThreads.delete(email.threadId);
    }

    // Mark email as read
    await gmail.users.messages.modify({
      userId: "me",
      id: email.id,
      resource: { removeLabelIds: ["UNREAD"] },
    });
  } catch (err) {
    console.error(`Error processing email ${email.id}:`, err);
  }
};

// Poll Gmail and process emails concurrently
const pollEmails = async () => {
  try {
    const response = await gmail.users.messages.list({
      userId: "me",
      q: "to:md@bursement.com is:unread",
      maxResults: 50, // fetch multiple emails top 50
    });

    const messages = response.data.messages || [];
    if (!messages.length) return;

    // Fetch full messages concurrently
    const fullMessages = await Promise.all(
      messages.map((msg) =>
        gmail.users.messages
          .get({ userId: "me", id: msg.id, format: "full" })
          .then((res) => res.data)
      )
    );

    // Process eligible emails concurrently
    await Promise.all(
      fullMessages.map(async (fullMessage) => {
        const headers = fullMessage.payload.headers;
        const subjectHeader = headers.find((h) => h.name === "Subject");
        const subject = subjectHeader ? subjectHeader.value : "";
        const threadId = fullMessage.threadId;

        if (subject.startsWith("Analysis:") || ongoingThreads.has(threadId)) {
          await processEmail(fullMessage);
        } else {
          // console.log(`Skipping normal email: ${subject}`);
        }
      })
    );
  } catch (err) {
    console.error("Error polling emails:", err.response?.data || err);
  }
};

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Poll every 1 minute
setInterval(pollEmails, 60 * 1000);

// Manual trigger endpoint
// app.get("/emails", async (req, res) => {
//   await pollEmails();
//   res.json({ status: "Emails processed" });
// });
