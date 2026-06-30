import React, { useCallback, useMemo, useEffect, useState, useRef } from 'react';
import { createEditor, Descendant } from 'slate';
import { Slate, Editable, withReact, ReactEditor } from 'slate-react';

// Custom types for Slate
type CustomElement = { type: 'paragraph'; children: CustomText[] };
type CustomText = { text: string; bold?: boolean; italic?: boolean };

declare module 'slate' {
  interface CustomTypes {
    Editor: ReactEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}

import type { UserPresence } from '../../shared/types/presence';
import type { UID } from '../../shared/types/operation';

interface RichTextEditorProps {
  text: string;
  onChange: (prev: string, next: string) => void;
  onSelect: (index: number) => void;
  presence?: UserPresence[];
  uidToIndex?: (uid: UID) => number | null;
}

// Convert string index to Slate path and offset
function indexToPoint(index: number, value: Descendant[]): { path: number[]; offset: number } | null {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const p = value[i] as CustomElement;
    let pTextLength = 0;
    for (let j = 0; j < p.children.length; j++) {
      pTextLength += p.children[j].text.length;
    }
    
    if (index <= count + pTextLength) {
      let leafCount = 0;
      for (let j = 0; j < p.children.length; j++) {
        const leaf = p.children[j];
        if (index <= count + leafCount + leaf.text.length) {
          return { path: [i, j], offset: index - count - leafCount };
        }
        leafCount += leaf.text.length;
      }
    }
    count += pTextLength + 1; // +1 for '\n'
  }
  return null;
}

export const RichTextEditor: React.FC<RichTextEditorProps> = ({ text, onChange, onSelect, presence = [], uidToIndex }) => {
  const editor = useMemo(() => withReact(createEditor()), []);

  // Helper to convert plain string from CRDT to Slate JSON
  const deserialize = (str: string): Descendant[] => {
    if (!str) return [{ type: 'paragraph', children: [{ text: '' }] }];
    return str.split('\n').map((line) => ({
      type: 'paragraph',
      children: [{ text: line }],
    }));
  };

  // Helper to convert Slate JSON back to plain string for CRDT
  const serialize = (nodes: Descendant[]): string => {
    return nodes.map((n: any) => n.children.map((c: any) => c.text).join('')).join('\n');
  };

  const [value, setValue] = useState<Descendant[]>(deserialize(text));
  const isLocalUpdate = useRef(false);

  // Sync external text changes (remote ops) to Slate value
  useEffect(() => {
    if (isLocalUpdate.current) {
      isLocalUpdate.current = false;
      return;
    }
    const currentText = serialize(value);
    if (text !== currentText) {
      setValue(deserialize(text));
    }
  }, [text]);

  const handleChange = (newValue: Descendant[]) => {
    setValue(newValue);
    isLocalUpdate.current = true;
    
    const nextStr = serialize(newValue);
    if (nextStr !== text) {
      onChange(text, nextStr);
    }
  };

  const handleSelect = useCallback(() => {
    const { selection } = editor;
    if (selection) {
      // Approximate the string index by adding up paragraph lengths
      let offset = 0;
      for (let i = 0; i < selection.anchor.path[0]; i++) {
        const node = value[i] as CustomElement;
        offset += node.children.map((c) => c.text).join('').length + 1; // +1 for '\n'
      }
      offset += selection.anchor.offset;
      onSelect(offset);
    }
  }, [editor, value, onSelect]);

  const decorate = useCallback(([node, path]: any) => {
    const ranges: any[] = [];
    if (!uidToIndex || !node.text) return ranges;

    presence.forEach((p) => {
      if (!p.cursor || !p.cursor.afterUid) return;
      const index = uidToIndex(p.cursor.afterUid);
      if (index === null) return;

      const point = indexToPoint(index, value);
      if (point && point.path[0] === path[0] && point.path[1] === path[1]) {
        ranges.push({
          anchor: { path, offset: point.offset },
          focus: { path, offset: Math.min(point.offset + 1, node.text.length) },
          isCursor: true,
          cursorColor: p.color || '#ff0000',
          cursorName: p.displayName,
          isTyping: p.isTyping,
        });
      }
    });

    return ranges;
  }, [presence, uidToIndex, value]);

  const renderLeaf = useCallback((props: any) => {
    const { attributes, children, leaf } = props;
    
    if (leaf.isCursor) {
      return (
        <span {...attributes} style={{ position: 'relative' }}>
          <span 
            style={{ 
              position: 'absolute', 
              left: -1, 
              top: 0, 
              bottom: 0, 
              width: 2, 
              backgroundColor: leaf.cursorColor 
            }} 
          />
          <div
            style={{
              position: 'absolute',
              left: -1,
              top: -18,
              backgroundColor: leaf.cursorColor,
              color: '#fff',
              fontSize: 10,
              padding: '2px 4px',
              borderRadius: '4px 4px 4px 0',
              whiteSpace: 'nowrap',
              zIndex: 10,
              pointerEvents: 'none',
              transition: 'opacity 0.2s',
              opacity: leaf.isTyping ? 1 : 0.8
            }}
          >
            {leaf.cursorName} {leaf.isTyping && '💬'}
          </div>
          {children}
        </span>
      );
    }
    
    return <span {...attributes}>{children}</span>;
  }, []);

  return (
    <div style={{ flex: 1, position: 'relative' }}>
      <Slate editor={editor} initialValue={value} onChange={handleChange}>
        <Editable
          onKeyUp={handleSelect}
          onMouseUp={handleSelect}
          decorate={decorate}
          renderLeaf={renderLeaf}
          placeholder="Start typing your collaborative masterpiece here..."
          style={{
            flex: 1,
            width: '100%',
            height: '100%',
            padding: 24,
            backgroundColor: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 15,
            lineHeight: 1.6,
          }}
          renderElement={(props) => (
            <p {...props.attributes} style={{ margin: '0 0 8px 0' }}>
              {props.children}
            </p>
          )}
        />
      </Slate>
    </div>
  );
};
