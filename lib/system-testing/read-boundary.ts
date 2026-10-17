/** Server-page read boundary only; service/RLS remains the authority. */
import { notFound } from 'next/navigation';
import { TestingRefusal } from './model';

export async function testingPageRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof TestingRefusal && (error.code === 'not_found' || error.code === 'not_assigned')) notFound();
    throw error;
  }
}
