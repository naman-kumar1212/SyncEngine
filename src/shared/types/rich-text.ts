/**
 * Slate.js-inspired rich text schema.
 * Represents a document as a tree of blocks and texts.
 */

export type TextFormatting = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
  backgroundColor?: string;
};

export interface TextNode {
  text: string;
  // formatting attributes
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
  backgroundColor?: string;
}

export interface ElementNode {
  type: 'paragraph' | 'heading-1' | 'heading-2' | 'heading-3' | 'block-quote' | 'list-item' | 'bulleted-list' | 'numbered-list' | 'table' | 'table-row' | 'table-cell' | 'image' | 'link';
  children: Descendant[];
  
  // Specific attributes depending on type
  url?: string;     // For images and links
  align?: 'left' | 'center' | 'right' | 'justify';
}

export type Descendant = ElementNode | TextNode;

// Helper to identify node types
export function isTextNode(node: Descendant): node is TextNode {
  return typeof (node as TextNode).text === 'string';
}

export function isElementNode(node: Descendant): node is ElementNode {
  return typeof (node as ElementNode).type === 'string' && Array.isArray((node as ElementNode).children);
}

// Represents the entire document
export type RichTextDocument = ElementNode[];
