/**
 * LLM Chat Application Template
 */

import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Frontend
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// ✅ Load chat history
		if (url.pathname === "/api/history") {
			const sessionId = url.searchParams.get("sessionId");

			if (!sessionId) {
				return Response.json(
					{ error: "Missing sessionId" },
					{ status: 400 }
				);
			}

			const result = await env.DB.prepare(
				"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC"
			)
				.bind(sessionId)
				.all();

			return Response.json(result.results);
		}

		// Chat API
		if (url.pathname === "/api/chat") {
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Save message helper
 */
async function saveMessage(
	env: Env,
	sessionId: string,
	role: string,
	content: string
) {
	await env.DB.prepare(
		"INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
	)
		.bind(sessionId, role, content)
		.run();
}

/**
 * Chat handler
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
	try {
		const { messages = [], sessionId } = (await request.json()) as {
			messages: ChatMessage[];
			sessionId: string;
		};

		// Validate session
		if (!sessionId) {
			return new Response("Missing sessionId", { status: 400 });
		}

		// Add system prompt if missing
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({
				role: "system",
				content: SYSTEM_PROMPT,
			});
		}

		// Save user message
		const lastUserMessage = messages[messages.length - 1];
		if (lastUserMessage?.role === "user") {
			await saveMessage(
				env,
				sessionId,
				"user",
				lastUserMessage.content
			);
		}

		// Call AI model (streaming)
		const stream = await env.AI.run(MODEL_ID, {
			messages,
			max_tokens: 1024,
			stream: true,
		});

		// Convert stream so we can also capture full response
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let fullResponse = "";

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();

		(async () => {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value);
				fullResponse += chunk;

				writer.write(value);
			}

			// Save assistant response
			await saveMessage(
				env,
				sessionId,
				"assistant",
				fullResponse
			);

			writer.close();
		})();

		return new Response(readable, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error(error);

		return Response.json(
			{ error: "Failed to process request" },
			{ status: 500 }
		);
	}
}
