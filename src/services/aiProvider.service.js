export class AiProviderService {
  constructor({ embeddingProvider, chatProvider }) {
    this.embeddingProvider = embeddingProvider;
    this.chatProvider = chatProvider;
  }

  embedDocuments(texts, requestOptions) {
    return this.embeddingProvider.embedDocuments(texts, requestOptions);
  }

  embedQuery(text, requestOptions) {
    return this.embeddingProvider.embedQuery(text, requestOptions);
  }

  generateStructured(input) {
    return this.chatProvider.generateStructured(input);
  }
}
