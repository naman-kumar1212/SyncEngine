import { RGADocument } from './rga-document';
import type { RGAOperation, InsertOperation, DeleteOperation, FormatOperation, UID } from '../shared/types/operation';

/**
 * Manages local user undo/redo stacks for a specific document.
 * Follows the Google Docs local-user undo model:
 * Clicking undo generates inverse operations only for this user's recent actions,
 * preserving convergence and not destroying other users' work.
 */
export class HistoryManager {
  private undoStack: RGAOperation[][] = [];
  private redoStack: RGAOperation[][] = [];
  private currentBatch: RGAOperation[] = [];
  private batchTimeout: NodeJS.Timeout | null = null;

  constructor(private doc: RGADocument, private localUserId: string) {}

  /**
   * Records a local operation. Groups operations into batches (e.g. typing a word).
   */
  recordLocalOperation(op: RGAOperation) {
    this.currentBatch.push(op);
    
    // Clear redo stack on new action
    if (this.redoStack.length > 0) {
      this.redoStack = [];
    }

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }

    // Commit batch after 500ms of inactivity
    this.batchTimeout = setTimeout(() => {
      this.commitBatch();
    }, 500);
  }

  commitBatch() {
    if (this.currentBatch.length > 0) {
      this.undoStack.push(this.currentBatch);
      this.currentBatch = [];
    }
  }

  /**
   * Generates inverse operations for the last batch of local edits.
   * Does NOT apply them; caller must broadcast and apply them like normal edits.
   */
  undo(): RGAOperation[] | null {
    this.commitBatch();
    const batch = this.undoStack.pop();
    if (!batch) return null;

    const inverseOps = this.createInverseOps(batch);
    this.redoStack.push(batch); // Push original ops to redo stack
    return inverseOps;
  }

  /**
   * Generates inverse operations for the last undone batch.
   */
  redo(): RGAOperation[] | null {
    this.commitBatch();
    const batch = this.redoStack.pop();
    if (!batch) return null;

    // The original ops are effectively the "redo" ops, but they need new UIDs and Lamport clocks 
    // when applied by the local client. The caller (sync engine) must generate new Insert/Delete ops.
    // For simplicity, we just return the batch and let the sync engine re-apply their logical equivalents.
    this.undoStack.push(batch);
    return batch; // Returning the original ops, caller must map them to new UIDs.
  }

  private createInverseOps(ops: RGAOperation[]): RGAOperation[] {
    const inverses: RGAOperation[] = [];
    
    // Process in reverse order for correct undo
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (op.type === 'INSERT') {
        // Inverse of insert is delete
        // Caller needs to provide a new operation envelope, this just defines the intent.
        // The actual DELETE op will use the INSERT's uid as the target.
        inverses.push({
          type: 'DELETE',
          uid: op.uid // we delete the node we just inserted
        });
      } else if (op.type === 'DELETE') {
        // Inverse of delete is insert (restore the node).
        // Since we can't un-tombstone in RGA (breaks idempotency), we must insert a NEW node.
        const node = this.doc.getNode(op.uid);
        if (node) {
          inverses.push({
            type: 'INSERT',
            uid: op.uid, // PLACEHOLDER: caller must replace with a fresh UID
            after: node.prev ? node.prev.uid : null,
            value: node.value
          });
        }
      } else if (op.type === 'FORMAT') {
        // Format undo requires knowing the PREVIOUS state of the attributes.
        // A true implementation needs to store the old attributes in the batch.
        // For now, this is a placeholder.
      }
    }
    return inverses;
  }
}
