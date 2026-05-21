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

		// ✅ NEW: Load chat history
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
	: string,
	role: string,
	content: string
) {
	await env.DB.prepare(
		"INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
	)
		.bind(, role, content)
		.run();
}

/**
 * Chat handler (UPDATED with DB logic)
 */
async function handleChatRequest(
	request: Request,
	env: Env
): Promise<Response> {
	try {
		const { messages = [],  } = (await request.json()) as {
			messages: ChatMessage[];
			: string;
		};

		if (!) {
			return new Response("Missing ", { status: 400 });
		}

		// Add system prompt
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		// ✅ Save user message (last message)
		const lastUserMessage = messages[messages.length - 1];
		if (lastUserMessage?.role === "user") {
			await saveMessage(env, , "user", lastUserMessage.content);
		}

		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages,
				max_tokens: 1024,
				stream: true,
			}
		);

		// Convert stream → response so we can save assistant output
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

			// Save assistant reply after streaming ends
			await saveMessage(env, , "assistant", fullResponse);

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
