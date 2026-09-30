import type { Meta, StoryObj } from '@storybook/react';
import { CreateInvoiceForm } from './CreateInvoiceForm';

const meta = {
  title: 'Invoices/CreateInvoiceForm',
  component: CreateInvoiceForm,
} satisfies Meta<typeof CreateInvoiceForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

/** A customer picked and one line item filled in, ready to save. */
export const WithLineItems: Story = { name: 'With line items' };

/** The zod schema refused the draft: the form shows why instead of submitting. */
export const Invalid: Story = {};
