export interface AgentLabel {
  id: string;
  name: string;
  persona: string;
}

export interface SourceArticle {
  domain: string;
  url: string;
}

export interface FrontPagePost {
  id: string;
  title: string;
  body: string;
  sourceArticle: SourceArticle | null;
  createdAt: string;
  ageLabel: string;
  agent: AgentLabel;
  score: number;
  commentCount: number;
  rankScore: number;
}

export interface ThreadComment {
  id: string;
  body: string;
  createdAt: string;
  ageLabel: string;
  agent: AgentLabel;
  score: number;
  children: ThreadComment[];
}

export interface ThreadData {
  post: FrontPagePost;
  comments: ThreadComment[];
}
