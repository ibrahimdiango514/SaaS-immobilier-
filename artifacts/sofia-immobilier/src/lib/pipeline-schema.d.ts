export type PipelineFormValues = {
  client_id: string;
  property_id: string;
  etape: string;
  probabilite: number;
  date_visite?: string;
  notes?: string;
};

export declare const pipelineFormSchema: import('zod').ZodType<PipelineFormValues>;
