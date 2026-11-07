import type { Request, Response } from 'express';
import { ProductService } from './product.service';

const createProduct = async (req: Request, res: Response) => {
  const result = await ProductService.createProduct(req.body);
  res.status(201).json({ message: 'Product created', data: result });
};
const updateProduct = async (req: Request, res: Response) => {
  const result = await ProductService.updateProduct(req.params.id, req.body);
  res.status(200).json({ message: 'Product updated', data: result });
};
const sellProduct = async (req: Request, res: Response) => {
  await ProductService.sellProduct(req.params.id, req.body.quantity);
  res.status(200).json({ message: 'Sold' });
};
const addTag = async (req: Request, res: Response) => {
  await ProductService.addTag(req.params.id, req.body.tag);
  res.status(200).json({ message: 'Tag added' });
};
const archiveProduct = async (req: Request, res: Response) => {
  await ProductService.archiveProduct(req.params.id);
  res.status(200).json({ message: 'Product archived' });
};
const deleteProduct = async (req: Request, res: Response) => {
  await ProductService.deleteProduct(req.params.id);
  res.status(200).json({ message: 'Product deleted' });
};
const restockProduct = async (req: Request, res: Response) => {
  await ProductService.restockProduct(req.params.id, req.body.quantity);
  res.status(200).json({ message: 'Restocked' });
};
export const ProductController = { createProduct, updateProduct, sellProduct, addTag, archiveProduct, deleteProduct, restockProduct };
