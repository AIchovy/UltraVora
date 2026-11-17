import type { ProviderType, ProviderTypeMap } from "./types.js";

export class ProviderRegistry {
  private byType = new Map<ProviderType, Map<string, ProviderTypeMap[ProviderType]>>();
  private order = new Map<ProviderType, string[]>();

  register<T extends ProviderType>(type: T, provider: ProviderTypeMap[T]): void {
    let bucket = this.byType.get(type);
    if (!bucket) {
      bucket = new Map();
      this.byType.set(type, bucket);
    }
    if (bucket.has(provider.id)) {
      throw new Error(`Duplicate provider registration for ${type}/${provider.id}`);
    }
    bucket.set(provider.id, provider);
    const ord = this.order.get(type) ?? [];
    ord.push(provider.id);
    this.order.set(type, ord);
  }

  get<T extends ProviderType>(type: T, id?: string): ProviderTypeMap[T] | undefined {
    const bucket = this.byType.get(type);
    if (!bucket) return undefined;
    if (id !== undefined) return bucket.get(id) as ProviderTypeMap[T] | undefined;
    const firstId = this.order.get(type)?.[0];
    if (firstId === undefined) return undefined;
    return bucket.get(firstId) as ProviderTypeMap[T];
  }

  require<T extends ProviderType>(type: T, id?: string): ProviderTypeMap[T] {
    const provider = this.get(type, id);
    if (!provider) {
      throw new Error(`No provider registered for ${type}${id ? `/${id}` : ""}`);
    }
    return provider;
  }
}
