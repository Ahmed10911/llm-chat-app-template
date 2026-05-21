/**
 * LLM Chat Application Template (Fixed with clean history storage)
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

		// Get chat history
		if (url.pathname === "/api/history") {
			const sessionId = url.searchParams.get("sessionId");

			if (!sessionId) {
				return Response.json({ error: "Missing sessionId" }, { status: 400 });
			}

			const result = await env.DB.prepare(
				"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC"
			)
				.bind(sessionId)
				.all();

			return Response.json(result.results);
		}

		// Chat endpoint
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
 * Chat handler (FIXED STREAM PARSING)
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
	try {
		const { messages = [], sessionId } = (await request.json()) as {
			messages: ChatMessage[];
			sessionId: string;
		};

		if (!sessionId) {
			return new Response("Missing sessionId", { status: 400 });
		}

		// Add system prompt if missing
		if (!messages.some((m) => m.role === "system")) {
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

		// AI stream
		const stream = await env.AI.run(MODEL_ID, {
			messages,
			max_tokens: 1024,
			stream: true,
		});

		const reader = stream.getReader();
		const decoder = new TextDecoder();

		let fullResponse = "";

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();

		(async () => {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });

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
							fullResponse += content;
						}
					} catch {
						// ignore malformed chunks
					}
				}

				writer.write(value);
			}

			// Save ONLY clean final response
			await saveMessage(env, sessionId, "assistant", fullResponse);

			writer.close();
		})();

		return new Response(readable, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (err) {
		console.error(err);

		return Response.json(
			{ error: "Failed to process request" },
			{ status: 500 }
		);
	}
}
