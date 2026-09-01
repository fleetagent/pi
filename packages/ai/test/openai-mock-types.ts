export interface MockOpenAIHttpResponse {
	status: number;
	headers: Headers;
}

export interface MockOpenAIResponse<TData> {
	data: TData;
	response: MockOpenAIHttpResponse;
}

export interface MockOpenAIRequestPromise<TData> extends Promise<TData> {
	withResponse: () => Promise<MockOpenAIResponse<TData>>;
}

export type MockCompletionResponse<TData> = MockOpenAIResponse<TData>;
export type MockCompletionPromise<TData> = MockOpenAIRequestPromise<TData>;
