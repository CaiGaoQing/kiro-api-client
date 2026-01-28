from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8045",
    api_key="sk-3790e086145d4c888a437598d6ca4375"
)

response = client.messages.create(
    model="gemini-3-pro-high",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)

print(response.content[0].text)
