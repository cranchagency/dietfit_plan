declare global {
  interface Window {
    cp: {
      CloudPayments: new () => {
        pay: (
          type: 'charge',
          options: {
            publicId: string;
            description: string;
            amount: number;
            currency: string;
            email: string;
            requireEmail: boolean;
            skin: string;
            data?: {
              cloudPayments?: {
                recurrent?: {
                  interval: string;
                  period: number;
                  amount: number;
                  currency: string;
                  failAmount?: number;
                }
              }
            }
          },
          callbacks: {
            onSuccess: (options: any) => void;
            onFail: (reason: any, options: any) => void;
            onComplete: (paymentResult: any, options: any) => void;
          }
        ) => void;
      };
    };
  }
}

export {};