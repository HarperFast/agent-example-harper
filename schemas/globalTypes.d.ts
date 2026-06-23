/**
 Generated from your schema files
 Manual changes will be lost!
 > harper dev .
 */
import type { Table } from 'harperdb';
import type { Conversation, Document, EmbeddingCache, Message, Note, Product, Stat, Tag, Trait, harperfast_nextjs_nextjs_build_info, harperfast_nextjs_nextjs_cache_invalidation, harperfast_nextjs_nextjs_isr_cache } from './types.ts';

declare module 'harperdb' {
	export const tables: {
		Conversation: { new(...args: any[]): Table<Conversation> };
		Document: { new(...args: any[]): Table<Document> };
		EmbeddingCache: { new(...args: any[]): Table<EmbeddingCache> };
		Message: { new(...args: any[]): Table<Message> };
		Note: { new(...args: any[]): Table<Note> };
		Product: { new(...args: any[]): Table<Product> };
		Stats: { new(...args: any[]): Table<Stat> };
		Tag: { new(...args: any[]): Table<Tag> };
		Traits: { new(...args: any[]): Table<Trait> };
	};

	export const databases: {
		data: {
			Conversation: { new(...args: any[]): Table<Conversation> };
			Document: { new(...args: any[]): Table<Document> };
			EmbeddingCache: { new(...args: any[]): Table<EmbeddingCache> };
			Message: { new(...args: any[]): Table<Message> };
			Note: { new(...args: any[]): Table<Note> };
			Product: { new(...args: any[]): Table<Product> };
			Stats: { new(...args: any[]): Table<Stat> };
			Tag: { new(...args: any[]): Table<Tag> };
			Traits: { new(...args: any[]): Table<Trait> };
		};
		harperfast_nextjs: {
			nextjs_build_info: { new(...args: any[]): Table<harperfast_nextjs_nextjs_build_info> };
			nextjs_cache_invalidation: { new(...args: any[]): Table<harperfast_nextjs_nextjs_cache_invalidation> };
			nextjs_isr_cache: { new(...args: any[]): Table<harperfast_nextjs_nextjs_isr_cache> };
		};
	};
}
