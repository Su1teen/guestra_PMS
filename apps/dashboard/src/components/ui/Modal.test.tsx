import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="Test">Content</Modal>);
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('renders title and children when open', () => {
    render(<Modal open={true} onClose={() => {}} title="My Modal">Modal body</Modal>);
    expect(screen.getByText('My Modal')).toBeInTheDocument();
    expect(screen.getByText('Modal body')).toBeInTheDocument();
  });

  it('calls onClose when X button clicked', async () => {
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose} title="Test">Body</Modal>);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when backdrop clicked', async () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">Body</Modal>,
    );
    await userEvent.click(screen.getByLabelText('Close Test'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('applies wide class when wide prop is true', () => {
    render(<Modal open={true} onClose={() => {}} title="Wide" wide>Content</Modal>);
    const modal = screen.getByText('Content').closest('.relative');
    expect(modal?.className).toContain('max-w-2xl');
  });

  it('recovers focus inside the dialog when a completed action removes its focused button', () => {
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as any);
    try {
      const { rerender } = render(<Modal open onClose={() => {}} title="Return"><button>Confirm return</button></Modal>);
      screen.getByRole('button', { name: 'Confirm return' }).focus();
      rerender(<Modal open onClose={() => {}} title="Return"><p>Returned</p></Modal>);
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(document.body, { key: 'Tab' });
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    } finally {
      rects.mockRestore();
    }
  });
});
