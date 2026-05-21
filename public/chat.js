// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Session ID (persistent per user)
const sessionId =
	localStorage.getItem("sessionId") ||
	crypto.randomUUID();

localStorage.setItem("sessionId", sessionId);

// Chat state
let chatHistory = [];
let isProcessing = false;

/**
 * Load chat history from backend
 */
async function loadChatHistory() {
	try {
		const res = await fetch(`/api/history?sessionId=${sessionId}`);
		const data = await res.json();

		if (!Array.isArray(data)) return;

		chatMessages.innerHTML = "";
		chatHistory = [];

		data.forEach((msg) => {
			chatHistory.push(msg);
			addMessageToChat(msg.role, msg.content);
		});
	} catch (err) {
		console.error("Failed to load history:", err);
	}
}

/**
 * Send message
 */
async function sendMessage() {
	const message = userInput.value.trim();
	if (!message || isProcessing) return;

	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	addMessageToChat("user", message);

	userInput.value = "";
	userInput.style.height = "auto";

	typingIndicator.classList.add("visible");

	chatHistory.push({ role: "user", content: message });

	try {
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: chatHistory,
				sessionId: sessionId,
			}),
		});

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		let responseText = "";

		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		const p = document.createElement("p");
		assistantMessageEl.appendChild(p);
		chatMessages.appendChild(assistantMessageEl);

		while (true) {
			const { value, done } = await reader.read();
			if (done) break;

			const chunk = decoder.decode(value);

			// Extract only response field safely
			const lines = chunk.split("\n");

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;

				const jsonStr = line.replace("data:", "").trim();
				if (jsonStr === "[DONE]") continue;

				try {
					const parsed = JSON.parse(jsonStr);

					const content =
						parsed.response ||
						parsed.choices?.[0]?.delta?.content ||
						"";

					if (content) {
						responseText += content;
						p.textContent = responseText;
					}
				} catch {}
			}
		}

		chatHistory.push({
			role: "assistant",
			content: responseText,
		});
	} catch (err) {
		console.error(err);
		addMessageToChat(
			"assistant",
			"Error processing request."
		);
	} finally {
		typingIndicator.classList.remove("visible");
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

/**
 * Add message to UI
 */
function addMessageToChat(role, content) {
	const div = document.createElement("div");
	div.className = `message ${role}-message`;
	div.innerHTML = `<p>${content}</p>`;
	chatMessages.appendChild(div);
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Events
sendButton.addEventListener("click", sendMessage);

userInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// Load history on start
window.addEventListener("DOMContentLoaded", loadChatHistory);
