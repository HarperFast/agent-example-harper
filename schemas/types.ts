/**
 Generated from HarperDB schema
 Manual changes will be lost!
 > harper dev .
 */
export interface Conversation {
	id: string;
	title?: string;
	createdAt?: string;
	updatedAt?: string;
}

export type NewConversation = Omit<Conversation, 'id'>;
export type { Conversation as ConversationRecord };
export type ConversationRecords = Conversation[];
export type NewConversationRecord = Omit<Conversation, 'id'>;

export interface Document {
	id: string;
	body?: string;
	embedding?: number[];
	title?: string;
}

export type NewDocument = Omit<Document, 'id'>;
export type { Document as DocumentRecord };
export type DocumentRecords = Document[];
export type NewDocumentRecord = Omit<Document, 'id'>;

export interface EmbeddingCache {
	id: string;
	embedding?: number[];
}

export type NewEmbeddingCache = Omit<EmbeddingCache, 'id'>;
export type { EmbeddingCache as EmbeddingCacheRecord };
export type EmbeddingCacheRecords = EmbeddingCache[];
export type NewEmbeddingCacheRecord = Omit<EmbeddingCache, 'id'>;

export interface Message {
	id: string;
	conversationId?: string;
	role?: string;
	content?: string;
	cost?: number;
	embedding?: number[];
	createdAt?: string;
}

export type NewMessage = Omit<Message, 'id'>;
export type { Message as MessageRecord };
export type MessageRecords = Message[];
export type NewMessageRecord = Omit<Message, 'id'>;

export interface Note {
	id: string;
	body?: string;
	tagId?: string;
	tag?: Tag;
	createdAt?: DateTime;
}

export type NewNote = Omit<Note, 'id'>;
export type { Note as NoteRecord };
export type NoteRecords = Note[];
export type NewNoteRecord = Omit<Note, 'id'>;

export interface Product {
	id: string;
	category?: string;
	description?: string;
	embedding?: number[];
	features?: string[];
	image?: string;
	name?: string;
	price?: number;
	specs?: Spec;
}

export type NewProduct = Omit<Product, 'id'>;
export type { Product as ProductRecord };
export type ProductRecords = Product[];
export type NewProductRecord = Omit<Product, 'id'>;

export interface Stat {
	id: string;
	totalSaved?: number;
	cacheHits?: number;
	updatedAt?: string;
}

export type NewStat = Omit<Stat, 'id'>;
export type Stats = Stat[];
export type { Stat as StatRecord };
export type StatRecords = Stat[];
export type NewStatRecord = Omit<Stat, 'id'>;

export interface Tag {
	id: string;
	name?: string;
}

export type NewTag = Omit<Tag, 'id'>;
export type { Tag as TagRecord };
export type TagRecords = Tag[];
export type NewTagRecord = Omit<Tag, 'id'>;

export interface Trait {
	id: string;
	traits?: string[];
}

export type NewTrait = Omit<Trait, 'id'>;
export type Traits = Trait[];
export type { Trait as TraitRecord };
export type TraitRecords = Trait[];
export type NewTraitRecord = Omit<Trait, 'id'>;

export interface harperfast_nextjs_nextjs_build_info {
	appName: string;
	buildId?: string;
	status?: string;
}

export type harperfast_nextjs_Newnextjs_build_info = Omit<harperfast_nextjs_nextjs_build_info, 'appName'>;
export type { harperfast_nextjs_nextjs_build_info as harperfast_nextjs_nextjs_build_infoRecord };
export type harperfast_nextjs_nextjs_build_infoRecords = harperfast_nextjs_nextjs_build_info[];
export type harperfast_nextjs_Newnextjs_build_infoRecord = Omit<harperfast_nextjs_nextjs_build_info, 'appName'>;

export interface harperfast_nextjs_nextjs_cache_invalidation {
	id: string;
	timestamp?: number;
}

export type harperfast_nextjs_Newnextjs_cache_invalidation = Omit<harperfast_nextjs_nextjs_cache_invalidation, 'id'>;
export type { harperfast_nextjs_nextjs_cache_invalidation as harperfast_nextjs_nextjs_cache_invalidationRecord };
export type harperfast_nextjs_nextjs_cache_invalidationRecords = harperfast_nextjs_nextjs_cache_invalidation[];
export type harperfast_nextjs_Newnextjs_cache_invalidationRecord = Omit<harperfast_nextjs_nextjs_cache_invalidation, 'id'>;

export interface harperfast_nextjs_nextjs_isr_cache {
	id: string;
	data?: any;
	lastModified?: number;
	tags?: string[];
}

export type harperfast_nextjs_Newnextjs_isr_cache = Omit<harperfast_nextjs_nextjs_isr_cache, 'id'>;
export type { harperfast_nextjs_nextjs_isr_cache as harperfast_nextjs_nextjs_isr_cacheRecord };
export type harperfast_nextjs_nextjs_isr_cacheRecords = harperfast_nextjs_nextjs_isr_cache[];
export type harperfast_nextjs_Newnextjs_isr_cacheRecord = Omit<harperfast_nextjs_nextjs_isr_cache, 'id'>;
